/* =====================================================================
 * EdgeOne KV 存储适配层 (JxPan D1 → EdgeOne Pages KV)
 *
 * 原理:
 *   JxPan 所有持久化(登录凭据/解析记录/统计/短链)都通过 `env.jxpan`
 *   这个 Cloudflare D1 对象, 用一组固定 SQL 读写三张表:
 *     kv_store / records_stats_cache / short_links
 *   本适配层实现一个同接口的"假 D1"(prepare().bind().first()/all()/run()),
 *   把每条 SQL 翻译成 EdgeOne Pages KV 的 get/put/delete/list 操作。
 *
 * 关键点:
 *   - EdgeOne KV 的 key 只允许 [数字|字母|下划线], 因此所有真实 key
 *     统一做 UTF-8 字节级 hex 编码(hex 序保持原 key 字典序, 前缀查询/排序语义不变)
 *   - EdgeOne KV put() 不支持 TTL, 过期时间(expires_at)存进 value JSON,
 *     读取时校验, 过期视为不存在并惰性删除
 *   - KV list({prefix,cursor,limit}) 上限 256/页, 内部自动翻页
 *   - 计数器类操作(短链访问数/统计增量)是读-改-写, KV 最终一致下极端
 *     并发可能丢计数, 只影响统计展示不影响解析功能
 * ===================================================================== */

(function () {
  'use strict';

  /* ---------- key 编码: UTF-8 字节 hex, 保序且只含 [0-9a-f] ---------- */
  function eoHexEncode(str) {
    const bytes = new TextEncoder().encode(String(str));
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }
  function eoHexDecode(hex) {
    const bytes = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  }

  /* 三张"表"的 KV key 前缀 */
  const P_KV = 'jxkv_';   // kv_store
  const P_SL = 'jxsl_';   // short_links
  const P_RS = 'jxrs_';   // records_stats_cache

  function nowSec() { return Math.floor(Date.now() / 1000); }

  function normSql(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }

  /* ---------- 在 env 与全局作用域中定位 EdgeOne KV 绑定 ---------- */
  function eoResolveKV(env) {
    const cands = [];
    const push = (v) => { if (v && !v.__isEOD1Shim) cands.push(v); };
    if (env && typeof env === 'object') {
      push(env.jxpan_kv); push(env.JXPAN_KV); push(env.KV);
      if (env.jxpan && typeof env.jxpan === 'object' && !env.jxpan.__isEOD1Shim &&
          typeof env.jxpan.get === 'function') push(env.jxpan);
    }
    for (const n of ['jxpan_kv', 'JXPAN_KV', 'jxpan', 'JXPAN', 'my_kv', 'KV', 'kv']) {
      try { if (typeof globalThis[n] !== 'undefined') push(globalThis[n]); } catch (e) { /* ignore */ }
    }
    for (const c of cands) {
      if (c && typeof c.get === 'function' && typeof c.put === 'function' &&
          typeof c.list === 'function' && typeof c.delete === 'function') return c;
    }
    return null;
  }

  /* ---------- list 自动翻页, 返回全部 key ---------- */
  async function eoListAllKeys(kv, prefix) {
    const keys = [];
    let cursor;
    for (let page = 0; page < 400; page++) {           // 400页 x 256 = 10万 key 上限保护
      let res;
      try {
        res = await kv.list({ prefix: prefix, cursor: cursor, limit: 256 });
      } catch (e) {
        if (page === 0 && cursor === undefined) throw e;   // 首次失败: 绑定不可用, 抛出
        break;                                             // 翻页中失败: 返回已获取部分
      }
      const ks = (res && Array.isArray(res.keys)) ? res.keys : [];
      for (const item of ks) keys.push(typeof item === 'string' ? item : item.key);
      const complete = !!(res && (res.complete === true || res.complete === undefined && !res.cursor));
      cursor = res && res.cursor ? res.cursor : null;
      if (complete || !cursor || ks.length === 0) break;
    }
    return keys;
  }

  /* ---------- 行级读写: KV value = JSON {v:值, e:过期秒, c:创建秒} ---------- */
  async function eoRowGet(kv, encKey) {
    let raw;
    try { raw = await kv.get(encKey); } catch (e) { throw new Error('EO-KV get 失败: ' + (e && e.message)); }
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (e) { return { v: raw, e: 0, c: 0 }; }
  }
  async function eoRowPut(kv, encKey, value, expiresAt) {
    const payload = JSON.stringify({ v: value, e: expiresAt || 0, c: nowSec() });
    await kv.put(encKey, payload);
  }
  function rowExpired(row, now) { return !row || (row.e > 0 && row.e < now); }

  /* ---------- SQL 执行路由 ---------- */
  async function eoExec(kv, sql, args, mode) {
    const N = normSql(sql);
    const a = args || [];
    const now = nowSec();
    const run = { success: true, meta: { changes: 1 } };
    const unsupported = () => {
      throw new Error('[EO-KV适配] 不支持的 SQL: ' + N.slice(0, 160));
    };

    /* ---- 建表/建索引: KV 无 schema, 直接忽略 ---- */
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(N)) return run;

    /* =============== kv_store =============== */
    let m;
    if ((m = N.match(/^INSERT OR REPLACE INTO kv_store \(key, value, expires_at\) VALUES \(\?, \?, \?\)$/i))) {
      await eoRowPut(kv, P_KV + eoHexEncode(a[0]), a[1], a[2]);
      return run;
    }
    if (/^SELECT value, expires_at FROM kv_store WHERE key = \?$/i.test(N)) {
      const row = await eoRowGet(kv, P_KV + eoHexEncode(a[0]));
      if (rowExpired(row, now)) { try { await kv.delete(P_KV + eoHexEncode(a[0])); } catch (e) { /* ignore */ } return null; }
      return { value: row.v, expires_at: row.e };
    }
    if (/^DELETE FROM kv_store WHERE key = \?$/i.test(N)) {
      try { await kv.delete(P_KV + eoHexEncode(a[0])); } catch (e) { /* ignore */ }
      return run;
    }
    if (/^DELETE FROM kv_store WHERE expires_at > 0 AND expires_at < \?$/i.test(N)) {
      const keys = await eoListAllKeys(kv, P_KV);
      for (const k of keys) {
        const row = await eoRowGet(kv, k);
        if (rowExpired(row, now)) { try { await kv.delete(k); } catch (e) { /* ignore */ } }
      }
      return run;
    }

    /* ---- kv_store 前缀查询: SELECT [key,] value ... LIKE ... [ORDER BY key DESC] [LIMIT n [OFFSET m]] ---- */
    if ((m = N.match(/^SELECT ([a-z_, ]+?) FROM kv_store WHERE key LIKE (?:'([^']*)'|\?)(?: ORDER BY key (ASC|DESC))?(?: LIMIT (\d+))?(?: OFFSET (\d+))?$/i))) {
      const cols = m[1].toLowerCase().split(',').map(function (s) { return s.trim(); });
      let pattern = m[2];
      if (pattern === undefined) pattern = String(a[0] === undefined ? '' : a[0]);
      const wantKey = cols.indexOf('key') !== -1;
      const wantValue = cols.indexOf('value') !== -1;
      let prefix = pattern.replace(/%+$/, '');
      let keys = await eoListAllKeys(kv, P_KV + eoHexEncode(prefix));
      if ((m[3] || '').toUpperCase() === 'DESC') keys.reverse();
      const limit = m[4] !== undefined ? parseInt(m[4], 10) : keys.length;
      const offset = m[5] !== undefined ? parseInt(m[5], 10) : 0;
      keys = keys.slice(offset, offset + limit);
      const rows = [];
      for (const k of keys) {
        const row = await eoRowGet(kv, k);
        if (rowExpired(row, now)) continue;
        const rec = {};
        if (wantKey) {
          const hexPart = k.startsWith(P_KV) ? k.slice(P_KV.length) : k;
          try { rec.key = eoHexDecode(hexPart); } catch (e) { rec.key = hexPart; }
        }
        if (wantValue) rec.value = row.v;
        rows.push(rec);
      }
      return mode === 'first' ? (rows[0] || null) : { results: rows };
    }

    /* ---- kv_store 计数: COUNT(*) as cnt / as total ---- */
    if ((m = N.match(/^SELECT COUNT\(\*\) as (cnt|total) FROM kv_store WHERE key LIKE '([^']*)'$/i))) {
      const keys = await eoListAllKeys(kv, P_KV + eoHexEncode(m[2].replace(/%+$/, '')));
      const row = {};
      row[m[1]] = keys.length;
      row.cnt = keys.length; row.total = keys.length;   // 兼容两种别名
      return mode === 'all' ? { results: [row] } : row;
    }

    /* =============== short_links =============== */
    if (/^SELECT shortcode FROM short_links WHERE shortcode = \?$/i.test(N)) {
      const row = await eoRowGet(kv, P_SL + eoHexEncode(a[0]));
      if (rowExpired(row, now)) return null;
      return { shortcode: a[0] };
    }
    if (/^INSERT INTO short_links \(shortcode, original_url, created_at\) VALUES \(\?, \?, strftime\('%s', 'now'\)\)$/i.test(N)) {
      await eoRowPut(kv, P_SL + eoHexEncode(a[0]), {
        shortcode: a[0], original_url: a[1],
        created_at: now, access_count: 0, last_accessed: 0, expires_at: 0
      }, 0);
      return run;
    }
    if (/^SELECT \* FROM short_links WHERE shortcode = \?$/i.test(N)) {
      const row = await eoRowGet(kv, P_SL + eoHexEncode(a[0]));
      if (rowExpired(row, now)) { try { await kv.delete(P_SL + eoHexEncode(a[0])); } catch (e) { /* ignore */ } return null; }
      if (!row) return null;
      const r = (row.v && typeof row.v === 'object') ? row.v : { shortcode: a[0], original_url: String(row.v || '') };
      return {
        shortcode: r.shortcode !== undefined ? r.shortcode : a[0],
        original_url: r.original_url !== undefined ? r.original_url : r.v,
        created_at: r.created_at || row.c || 0,
        access_count: r.access_count || 0,
        last_accessed: r.last_accessed || 0,
        expires_at: r.expires_at || row.e || 0
      };
    }
    if (/^UPDATE short_links SET access_count = access_count \+ 1, last_accessed = strftime\('%s', 'now'\) WHERE shortcode = \?$/i.test(N)) {
      const enc = P_SL + eoHexEncode(a[0]);
      const row = await eoRowGet(kv, enc);
      if (!row) return run;
      const r = (row.v && typeof row.v === 'object') ? row.v : { shortcode: a[0], original_url: String(row.v || '') };
      r.access_count = (r.access_count || 0) + 1;
      r.last_accessed = now;
      await eoRowPut(kv, enc, r, row.e || 0);
      return run;
    }

    /* =============== records_stats_cache =============== */
    if (/^SELECT cache_key, cache_value, updated_at FROM records_stats_cache WHERE cache_key IN \('stats_success_total', 'stats_failed_total', 'stats_total'\)$/i.test(N)) {
      const names = ['stats_success_total', 'stats_failed_total', 'stats_total'];
      const rows = [];
      for (const name of names) {
        const row = await eoRowGet(kv, P_RS + eoHexEncode(name));
        rows.push({
          cache_key: name,
          cache_value: row && row.v !== undefined ? String(row.v) : '0',
          updated_at: row ? (row.e || 0) : 0
        });
      }
      return mode === 'first' ? rows[0] : { results: rows };
    }
    if ((m = N.match(/^INSERT OR REPLACE INTO records_stats_cache \(cache_key, cache_value, updated_at\) VALUES \('([a-z_]+)', \?, \?\)$/i))) {
      await eoRowPut(kv, P_RS + eoHexEncode(m[1]), String(a[0]), a[1] || 0);
      return run;
    }
    if (/^UPDATE records_stats_cache SET cache_value = CAST\(cache_value AS INTEGER\) \+ 1, updated_at = \? WHERE cache_key = \?$/i.test(N)) {
      const enc = P_RS + eoHexEncode(a[1]);
      const row = await eoRowGet(kv, enc);
      const cur = row && row.v !== undefined ? parseInt(row.v, 10) || 0 : 0;
      await eoRowPut(kv, enc, String(cur + 1), a[0] || now);
      return run;
    }

    unsupported();
    return run;
  }

  class EOD1Statement {
    constructor(kv, sql) { this.kv = kv; this.sql = sql; this._args = []; }
    bind(...a) { this._args = a; return this; }
    async run() { return eoExec(this.kv, this.sql, this._args, 'run'); }
    async first() { return eoExec(this.kv, this.sql, this._args, 'first'); }
    async all() { return eoExec(this.kv, this.sql, this._args, 'all'); }
    async raw() { const r = await this.all(); return (r && r.results) || []; }
  }

  class EOD1Shim {
    constructor(kv) { this.kv = kv; this.__isEOD1Shim = true; }
    prepare(sql) { return new EOD1Statement(this.kv, sql); }
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    }
  }

  function eoAttachShim(env) {
    let envObj = env;
    if (!envObj || typeof envObj !== 'object') envObj = {};
    if (envObj.jxpan && envObj.jxpan.__isEOD1Shim) return envObj;
    const kv = eoResolveKV(envObj);
    if (kv) {
      envObj.jxpan = new EOD1Shim(kv);
      console.log('[EdgeOne适配] 已挂载 KV→D1 存储适配层');
    } else {
      console.warn('[EdgeOne适配] 未找到 KV 绑定(请在 EdgeOne 控制台将 KV 命名空间以变量名 jxpan 绑定到项目),' +
        '将以无存储模式运行: 登录凭据保存/解析记录/统计/短链不可用, 仅直链解析可用');
    }
    return envObj;
  }

  /* 导出到模块作用域, 供入口 onRequest 使用 */
  globalThis.__EO_JXPAN__ = { eoAttachShim: eoAttachShim, EOD1Shim: EOD1Shim, eoResolveKV: eoResolveKV };
})();

/* ===================== EdgeOne 入口适配 =====================
 * EdgeOne Pages Functions 规范: functions/[[default]].js 全捕获路由,
 * 导出 onRequest(context); context = { request, env, params, ... }
 * 这里把 context 转换为 JxPan 期望的 (request, env, ctx) 三元组。
 * ============================================================ */
export async function onRequest(context) {
  const request = context && context.request;
  const envRaw = (context && context.env) || {};
  const env = globalThis.__EO_JXPAN__.eoAttachShim(envRaw);
  const ctxShim = {
    waitUntil(p) { try { if (p && typeof p.then === 'function') p.then(function () {}, function () {}); } catch (e) { /* ignore */ } }
  };
  return __JXPAN_WORKER.fetch(request, env, ctxShim);
}

/* 兼容 Cloudflare Workers 部署方式: 同一份文件也可直接用于 CF */
export { __JXPAN_WORKER as default };
