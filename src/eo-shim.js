/* =====================================================================
 * JxPan 存储适配层 —— 多平台版
 *   把 JxPan(Cloudflare D1)用到的固定 SQL 翻译为平台 KV 操作,
 *   同时支持:
 *     1) 腾讯 EdgeOne Pages KV(有 list,前缀查询直查)
 *     2) 阿里云 ESA 边缘函数 EdgeKV(无 list,用按天索引桶实现前缀查询)
 *     3) Cloudflare Workers(同份入口文件可直接复用,存储需自行绑定)
 *
 * 共同要点:
 *   - EdgeOne KV 的 key 只允许 [数字|字母|下划线],ESA 未文档化限制但为稳妥
 *     统一做 UTF-8 字节 hex 编码(保序,前缀查询/排序语义不变)
 *   - 两平台 KV put 均无 TTL(EdgeOne 无该参数,ESA 上限 1.8MB/值):
 *     过期时间存进 value JSON {v,e,c},读取时校验并惰性删除
 *
 * ESA EdgeKV 限制(get/put/delete,无 list):
 *   - 前缀查询通过"索引桶"实现:写入 key 时把原始 key 归档到
 *     eo_idx_<组前缀>_<天号> 桶(天号取 key 内的时间戳,天),查询时
 *     从今天往回扫 ESA_INDEX_DAYS 天。仅覆盖 parse_record_ / test_ 两个
 *     JxPan 实际用到的前缀,其余前缀查询返回空并在日志告警
 *   - 桶为读-改-写,同一秒内并发写同一桶可能丢个别记录(仅影响后台
 *     记录列表/统计展示,不影响解析功能)
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

  const nowSec = function () { return Math.floor(Date.now() / 1000); };
  const normSql = function (sql) { return String(sql).replace(/\s+/g, ' ').trim(); };

  /* 可按需调整:ESA 索引桶回扫天数 / EdgeKV 命名空间名 */
  var ESA_INDEX_DAYS = 60;
  var ESA_KV_NAMESPACE_DEFAULT = 'jxpan';

  /* ================== Provider 1: EdgeOne Pages KV(原生 list) ================== */
  function eoEdgeOneProvider(kv) {
    return {
      __kind: 'edgeone',
      async get(k) { const v = await kv.get(k); return (v === null || v === undefined) ? null : v; },
      async put(k, v) { await kv.put(k, v); },
      async del(k) { await kv.delete(k); },
      async listKeys(prefix) {
        const keys = [];
        let cursor;
        for (let page = 0; page < 400; page++) {          // 400页 x 256 = 10万 key 上限保护
          let res;
          try {
            res = await kv.list({ prefix: prefix, cursor: cursor, limit: 256 });
          } catch (e) {
            if (page === 0 && cursor === undefined) throw e;   // 首次失败: 绑定不可用, 抛出
            break;                                             // 翻页中失败: 返回已获取部分
          }
          const ks = (res && Array.isArray(res.keys)) ? res.keys : [];
          for (const item of ks) keys.push(typeof item === 'string' ? item : item.key);
          const complete = !!(res && (res.complete === true || (res.complete === undefined && !res.cursor)));
          cursor = res && res.cursor ? res.cursor : null;
          if (complete || !cursor || ks.length === 0) break;
        }
        return keys;
      }
    };
  }

  /* ================== Provider 2: 阿里云 ESA EdgeKV(无 list, 索引桶) ================== */
  function eoEsaProvider(env) {
    var namespace = (env && (env.EO_KV_NAMESPACE || env.ER_KV_NAMESPACE || env.KV_NAMESPACE)) || ESA_KV_NAMESPACE_DEFAULT;
    var kvInst = null;
    function kv() {
      if (!kvInst) {
        if (typeof globalThis.EdgeKV !== 'function') {
          throw new Error('[EO-KV适配] 未找到 EdgeKV 全局类: 请确认运行在 ESA 边缘函数环境, 且已在控制台创建存储空间 "' + namespace + '"');
        }
        kvInst = new globalThis.EdgeKV({ namespace: namespace });
      }
      return kvInst;
    }

    /* 解出编码 key 的 {表前缀, 原始key}; 非三表前缀返回 null */
    function decodeStoredKey(encKey) {
      for (const p of [P_KV, P_SL, P_RS]) {
        if (encKey.indexOf(p) === 0) {
          try { return { table: p, key: eoHexDecode(encKey.slice(p.length)) }; }
          catch (e) { return null; }
        }
      }
      return null;
    }

    /* JxPan 实际做前缀查询的组; key 形如 <组前缀><时间戳ms> */
    var INDEX_GROUPS = ['parse_record_', 'test_'];
    function bucketKey(group, day) { return 'eo_idx_' + eoHexEncode(group) + '_' + day; }
    function dayOfKey(origKey) {
      for (const g of INDEX_GROUPS) {
        if (origKey.indexOf(g) === 0) {
          const tail = origKey.slice(g.length);
          if (/^\d{12,}$/.test(tail)) return Math.floor(Number(tail) / 86400000);   // ms 时间戳 → 天
          return 'misc';
        }
      }
      return null;   // 不在索引组内
    }

    async function bucketRead(bk) {
      try {
        const raw = await kv().get(bk, { type: 'text' });
        if (raw === null || raw === undefined) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }
    async function bucketWrite(bk, keys) {
      if (keys.length === 0) { try { await kv().delete(bk); } catch (e) { /* ignore */ } return; }
      await kv().put(bk, JSON.stringify(keys));
    }
    async function idxAdd(origKey) {
      const day = dayOfKey(origKey);
      if (day === null) return;
      for (const g of INDEX_GROUPS) {
        if (origKey.indexOf(g) === 0) {
          const bk = bucketKey(g, day);
          const list = await bucketRead(bk);
          if (list.indexOf(origKey) === -1) { list.push(origKey); await bucketWrite(bk, list); }
          return;
        }
      }
    }
    async function idxRemove(origKey) {
      const day = dayOfKey(origKey);
      if (day === null) return;
      for (const g of INDEX_GROUPS) {
        if (origKey.indexOf(g) === 0) {
          const bk = bucketKey(g, day);
          const list = await bucketRead(bk);
          const i = list.indexOf(origKey);
          if (i !== -1) { list.splice(i, 1); await bucketWrite(bk, list); }
          return;
        }
      }
    }

    return {
      __kind: 'esa',
      namespace: namespace,
      async get(k) {
        const v = await kv().get(k, { type: 'text' });
        return (v === null || v === undefined) ? null : v;
      },
      async put(k, v) {
        await kv().put(k, v);
        const d = decodeStoredKey(k);
        if (d) { try { await idxAdd(d.key); } catch (e) { console.warn('[EO-KV适配] 索引写入失败:', e && e.message); } }
      },
      async del(k) {
        await kv().delete(k);
        const d = decodeStoredKey(k);
        if (d) { try { await idxRemove(d.key); } catch (e) { /* ignore */ } }
      },
      /* 前缀查询(参数为编码后的 KV key 前缀): 经索引桶聚合, 升序返回 */
      async listKeys(encPrefix) {
        const d = decodeStoredKey(encPrefix);
        if (!d) return [];
        const group = INDEX_GROUPS.find(function (g) { return d.key.indexOf(g) === 0 || g.indexOf(d.key) === 0; });
        if (!group) {
          console.warn('[EO-KV适配] ESA EdgeKV 无 list 能力, 未建立索引的前缀查询返回空:', d.key);
          return [];
        }
        const today = Math.floor(Date.now() / 86400000);
        const buckets = [];
        for (let i = 0; i < ESA_INDEX_DAYS; i++) buckets.push(bucketKey(group, today - i));
        buckets.push(bucketKey(group, 'misc'));
        const out = [];
        for (const bk of buckets) {
          const list = await bucketRead(bk);
          for (const k of list) {
            if (k.indexOf(d.key) === 0 && out.indexOf(k) === -1) out.push(k);
          }
        }
        out.sort();
        return out.map(function (origKey) { return P_KV + eoHexEncode(origKey); });
      }
    };
  }

  /* ================== Provider 解析 ================== */
  function eoResolveProvider(env) {
    var cand = [];
    var push = function (v) { if (v && !v.__isEOD1Shim && !v.__isEOProvider) cand.push(v); };
    if (env && typeof env === 'object') {
      push(env.jxpan_kv); push(env.JXPAN_KV); push(env.KV);
      if (env.jxpan && typeof env.jxpan === 'object' && !env.jxpan.__isEOD1Shim &&
          typeof env.jxpan.get === 'function') push(env.jxpan);
      if (env.__eoProvider) return env.__eoProvider;                 // 测试注入
    }
    for (var n of ['jxpan_kv', 'JXPAN_KV', 'jxpan', 'JXPAN', 'my_kv', 'KV', 'kv']) {
      try { if (typeof globalThis[n] !== 'undefined') push(globalThis[n]); } catch (e) { /* ignore */ }
    }
    for (var c of cand) {
      if (c && typeof c.get === 'function' && typeof c.put === 'function' &&
          typeof c.list === 'function' && typeof c.delete === 'function') {
        return eoEdgeOneProvider(c);
      }
    }
    if (typeof globalThis.EdgeKV === 'function') return eoEsaProvider(env);   // 阿里云 ESA
    return null;
  }

  /* ---------- 行级读写: KV value = JSON {v:值, e:过期秒, c:创建秒} ---------- */
  async function eoRowGet(p, encKey) {
    let raw;
    try { raw = await p.get(encKey); } catch (e) { throw new Error('EO-KV get 失败: ' + (e && e.message)); }
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (e) { return { v: raw, e: 0, c: 0 }; }
  }
  async function eoRowPut(p, encKey, value, expiresAt) {
    const payload = JSON.stringify({ v: value, e: expiresAt || 0, c: nowSec() });
    await p.put(encKey, payload);
  }
  function rowExpired(row, now) { return !row || (row.e > 0 && row.e < now); }

  /* ================== SQL 执行路由 ================== */
  async function eoExec(p, sql, args, mode) {
    const N = normSql(sql);
    const a = args || [];
    const now = nowSec();
    const run = { success: true, meta: { changes: 1 } };
    const unsupported = function () {
      throw new Error('[EO-KV适配] 不支持的 SQL: ' + N.slice(0, 160));
    };

    /* ---- 建表/建索引: KV 无 schema, 直接忽略 ---- */
    if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(N)) return run;

    /* =============== kv_store =============== */
    var m;
    if ((m = N.match(/^INSERT OR REPLACE INTO kv_store \(key, value, expires_at\) VALUES \(\?, \?, \?\)$/i))) {
      await eoRowPut(p, P_KV + eoHexEncode(a[0]), a[1], a[2]);
      return run;
    }
    if (/^SELECT value, expires_at FROM kv_store WHERE key = \?$/i.test(N)) {
      const row = await eoRowGet(p, P_KV + eoHexEncode(a[0]));
      if (rowExpired(row, now)) { try { await p.del(P_KV + eoHexEncode(a[0])); } catch (e) { /* ignore */ } return null; }
      return { value: row.v, expires_at: row.e };
    }
    if (/^DELETE FROM kv_store WHERE key = \?$/i.test(N)) {
      try { await p.del(P_KV + eoHexEncode(a[0])); } catch (e) { /* ignore */ }
      return run;
    }
    if (/^DELETE FROM kv_store WHERE expires_at > 0 AND expires_at < \?$/i.test(N)) {
      const keys = await p.listKeys(P_KV);
      for (const k of keys) {
        const row = await eoRowGet(p, k);
        if (rowExpired(row, now)) { try { await p.del(k); } catch (e) { /* ignore */ } }
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
      let keys = await p.listKeys(P_KV + eoHexEncode(prefix));
      if ((m[3] || '').toUpperCase() === 'DESC') keys.reverse();
      const limit = m[4] !== undefined ? parseInt(m[4], 10) : keys.length;
      const offset = m[5] !== undefined ? parseInt(m[5], 10) : 0;
      keys = keys.slice(offset, offset + limit);
      const rows = [];
      for (const k of keys) {
        const row = await eoRowGet(p, k);
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
      const keys = await p.listKeys(P_KV + eoHexEncode(m[2].replace(/%+$/, '')));
      const row = {};
      row[m[1]] = keys.length;
      row.cnt = keys.length; row.total = keys.length;   // 兼容两种别名
      return mode === 'all' ? { results: [row] } : row;
    }

    /* =============== short_links =============== */
    if (/^SELECT shortcode FROM short_links WHERE shortcode = \?$/i.test(N)) {
      const row = await eoRowGet(p, P_SL + eoHexEncode(a[0]));
      if (rowExpired(row, now)) return null;
      return { shortcode: a[0] };
    }
    if (/^INSERT INTO short_links \(shortcode, original_url, created_at\) VALUES \(\?, \?, strftime\('%s', 'now'\)\)$/i.test(N)) {
      await eoRowPut(p, P_SL + eoHexEncode(a[0]), {
        shortcode: a[0], original_url: a[1],
        created_at: now, access_count: 0, last_accessed: 0, expires_at: 0
      }, 0);
      return run;
    }
    if (/^SELECT \* FROM short_links WHERE shortcode = \?$/i.test(N)) {
      const row = await eoRowGet(p, P_SL + eoHexEncode(a[0]));
      if (rowExpired(row, now)) { try { await p.del(P_SL + eoHexEncode(a[0])); } catch (e) { /* ignore */ } return null; }
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
      const row = await eoRowGet(p, enc);
      if (!row) return run;
      const r = (row.v && typeof row.v === 'object') ? row.v : { shortcode: a[0], original_url: String(row.v || '') };
      r.access_count = (r.access_count || 0) + 1;
      r.last_accessed = now;
      await eoRowPut(p, enc, r, row.e || 0);
      return run;
    }

    /* =============== records_stats_cache =============== */
    if (/^SELECT cache_key, cache_value, updated_at FROM records_stats_cache WHERE cache_key IN \('stats_success_total', 'stats_failed_total', 'stats_total'\)$/i.test(N)) {
      const names = ['stats_success_total', 'stats_failed_total', 'stats_total'];
      const rows = [];
      for (const name of names) {
        const row = await eoRowGet(p, P_RS + eoHexEncode(name));
        rows.push({
          cache_key: name,
          cache_value: row && row.v !== undefined ? String(row.v) : '0',
          updated_at: row ? (row.e || 0) : 0
        });
      }
      return mode === 'first' ? rows[0] : { results: rows };
    }
    if ((m = N.match(/^INSERT OR REPLACE INTO records_stats_cache \(cache_key, cache_value, updated_at\) VALUES \('([a-z_]+)', \?, \?\)$/i))) {
      await eoRowPut(p, P_RS + eoHexEncode(m[1]), String(a[0]), a[1] || 0);
      return run;
    }
    if (/^UPDATE records_stats_cache SET cache_value = CAST\(cache_value AS INTEGER\) \+ 1, updated_at = \? WHERE cache_key = \?$/i.test(N)) {
      const enc = P_RS + eoHexEncode(a[1]);
      const row = await eoRowGet(p, enc);
      const cur = row && row.v !== undefined ? parseInt(row.v, 10) || 0 : 0;
      await eoRowPut(p, enc, String(cur + 1), a[0] || now);
      return run;
    }

    unsupported();
    return run;
  }

  class EOD1Statement {
    constructor(p, sql) { this.p = p; this.sql = sql; this._args = []; }
    bind(...a) { this._args = a; return this; }
    async run() { return eoExec(this.p, this.sql, this._args, 'run'); }
    async first() { return eoExec(this.p, this.sql, this._args, 'first'); }
    async all() { return eoExec(this.p, this.sql, this._args, 'all'); }
    async raw() { const r = await this.all(); return (r && r.results) || []; }
  }

  class EOD1Shim {
    constructor(p) { this.p = p; this.__isEOD1Shim = true; }
    prepare(sql) { return new EOD1Statement(this.p, sql); }
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
    const provider = eoResolveProvider(envObj);
    if (provider) {
      envObj.jxpan = new EOD1Shim(provider);
      console.log('[EdgeOne/ESA适配] 已挂载存储适配层 (' + provider.__kind + ', ' +
        (provider.namespace ? 'KV空间: ' + provider.namespace : '绑定变量') + ')');
    } else {
      console.warn('[EdgeOne/ESA适配] 未找到可用的 KV 存储(EdgeOne: 绑定变量名 jxpan; ESA: 创建 EdgeKV 存储空间 jxpan),' +
        '将以无存储模式运行: 登录凭据保存/解析记录/统计/短链不可用, 仅直链解析可用');
    }
    return envObj;
  }

  globalThis.__EO_JXPAN__ = { eoAttachShim: eoAttachShim, EOD1Shim: EOD1Shim, eoResolveProvider: eoResolveProvider };
})();

/* ===================== 入口适配(双平台) =====================
 * EdgeOne Pages / CF Pages: functions/[[default]].js → onRequest(context)
 * 阿里云 ESA 边缘函数 / CF Workers: export default { async fetch(request, env, ctx) }
 * 两者最终都调用 JxPan 的 fetch(request, env, ctx)。
 * ============================================================ */
export async function onRequest(context) {
  const request = context && context.request;
  const env = globalThis.__EO_JXPAN__.eoAttachShim((context && context.env) || {});
  const ctxShim = {
    waitUntil(p) { try { if (p && typeof p.then === 'function') p.then(function () {}, function () {}); } catch (e) { /* ignore */ } }
  };
  return __JXPAN_WORKER.fetch(request, env, ctxShim);
}

export default {
  async fetch(request, env, ctx) {
    const e = globalThis.__EO_JXPAN__.eoAttachShim(env || {});
    const ctxShim = (ctx && typeof ctx.waitUntil === 'function') ? ctx : {
      waitUntil(p) { try { if (p && typeof p.then === 'function') p.then(function () {}, function () {}); } catch (err) { /* ignore */ } }
    };
    return __JXPAN_WORKER.fetch(request, e, ctxShim);
  }
};
