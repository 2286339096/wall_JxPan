/**
 * 本地冒烟测试: 验证 functions/[[default]].js 能加载、双平台入口能分发、
 * D1→KV 适配层在两种后端下都覆盖 JxPan 用到的全部 SQL 家族:
 *   Phase A  EdgeOne 模式 —— 原生 list 的 KV(通过 globalThis.jxpan 绑定)
 *   Phase B  阿里云 ESA 模式 —— 无 list 的 EdgeKV(通过 globalThis.EdgeKV,索引桶方案)
 *
 * 运行: node test/mock-kv.test.mjs
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'functions', '[[default]].js');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  -- ' + extra : '')); }
}

/* ---------- MockKV: EdgeOne KV 语义(有 list, cursor 翻页) ---------- */
const ALLOWED = /^[0-9a-zA-Z_]+$/;
class MockKV {
  constructor() { this.m = new Map(); }
  _check(key) {
    if (!ALLOWED.test(key)) throw new Error('MockKV: key 含非法字符: ' + key);
    if (Buffer.byteLength(key) > 512) throw new Error('MockKV: key 超长');
  }
  async get(key) { this._check(key); const v = this.m.get(key); return v === undefined ? null : v; }
  async put(key, value) { this._check(key); this.m.set(key, String(value)); }
  async delete(key) { this.m.delete(key); }
  async list({ prefix = '', cursor, limit = 256 } = {}) {
    let keys = [...this.m.keys()].sort();
    if (prefix) keys = keys.filter(k => k.startsWith(prefix));
    let start = 0;
    if (cursor) { start = keys.findIndex(k => k > cursor); if (start === -1) start = keys.length; }
    const page = keys.slice(start, start + limit);
    const nextCursor = start + limit < keys.length ? keys[start + limit - 1] : null;
    return { keys: page.map(key => ({ key })), cursor: nextCursor, complete: nextCursor === null };
  }
}

/* ---------- MockEdgeKV: ESA EdgeKV 语义(只有 get/put/delete, 无 list) ---------- */
let esaStore = new Map();   // provider 以 new EdgeKV({namespace}) 实例化, store 用模块级 Map
class MockEdgeKV {
  constructor(opts) { this.m = esaStore; }
  async get(key, opts) {
    this._check(key);
    const v = this.m.get(key);
    if (v === undefined) return undefined;
    return v;
  }
  async put(key, value) {
    this._check(key);
    if (Buffer.byteLength(String(value)) > 1.8 * 1024 * 1024) throw new Error('MockEdgeKV: value 超过 1.8MB');
    this.m.set(key, String(value));
  }
  async delete(key) { this._check(key); this.m.delete(key); return true; }
  _check(key) { if (!ALLOWED.test(key)) throw new Error('MockEdgeKV: key 含非法字符: ' + key); }
}

const bundleURL = pathToFileURL(bundlePath).href;

/* ================= 共用 SQL 套件 ================= */
async function storageSuite(label, db) {
  const now = Math.floor(Date.now() / 1000);
  console.log('\n-- [' + label + '] D1→KV 适配层 SQL 家族 --');

  await db.prepare(`CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')) )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_store(expires_at)').run();
  ok(true, '[' + label + '] CREATE TABLE/INDEX 兼容执行');

  await db.prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
    .bind('login:quark', '{"k":"v"}', now + 3600).run();
  const got = await db.prepare('SELECT value, expires_at FROM kv_store WHERE key = ?').bind('login:quark').first();
  ok(got && got.value === '{"k":"v"}' && got.expires_at === now + 3600, '[' + label + '] kv_store put/get 往返', JSON.stringify(got));

  await db.prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
    .bind('login:expired', 'x', now - 10).run();
  const exp = await db.prepare('SELECT value, expires_at FROM kv_store WHERE key = ?').bind('login:expired').first();
  ok(exp === null, '[' + label + '] 过期 key 读取返回 null');

  const weirdKey = 'cache:https://pan.quark.cn/s/abc?fid=1#x@pwd';
  await db.prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(weirdKey, 'OK', 0).run();
  const weirdGot = await db.prepare('SELECT value, expires_at FROM kv_store WHERE key = ?').bind(weirdKey).first();
  ok(weirdGot && weirdGot.value === 'OK', '[' + label + '] 含 URL 特殊字符的 key 正常存取');

  for (let i = 1; i <= 5; i++) {
    await db.prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
      .bind('parse_record_' + String(i).padStart(3, '0'), JSON.stringify({ url: 'u' + i, ok: true }), 0).run();
  }
  const cnt = await db.prepare("SELECT COUNT(*) as cnt FROM kv_store WHERE key LIKE 'parse_record_%'").first();
  ok(cnt && cnt.cnt === 5, '[' + label + '] COUNT(*) cnt = 5', JSON.stringify(cnt));
  const cnt2 = await db.prepare("SELECT COUNT(*) as total FROM kv_store WHERE key LIKE 'parse_record_%'").first();
  ok(cnt2 && cnt2.total === 5, '[' + label + '] COUNT(*) total = 5', JSON.stringify(cnt2));

  const page1 = await db.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'parse_record_%' ORDER BY key DESC LIMIT 2 OFFSET 0").all();
  ok(page1.results.length === 2 &&
     page1.results[0].key === 'parse_record_005' &&
     page1.results[1].key === 'parse_record_004', '[' + label + '] 前缀查询 DESC + LIMIT/OFFSET 正确', JSON.stringify(page1.results.map(r => r.key)));
  const page2 = await db.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'parse_record_%' ORDER BY key DESC LIMIT 2 OFFSET 2").all();
  ok(page2.results[0].key === 'parse_record_003', '[' + label + '] 第二页 OFFSET 正确', JSON.stringify(page2.results.map(r => r.key)));
  const vonly = await db.prepare("SELECT value FROM kv_store WHERE key LIKE 'parse_record_%' ORDER BY key DESC LIMIT 1 OFFSET 0").all();
  ok(vonly.results.length === 1 && vonly.results[0].value && vonly.results[0].key === undefined, '[' + label + '] 仅查 value 列时行不含 key');

  const rec = JSON.parse(page1.results[0].value);
  ok(rec && rec.url === 'u5', '[' + label + '] 记录值 JSON 完整');

  const bound = await db.prepare('SELECT key, value FROM kv_store WHERE key LIKE ?').bind('parse_record_' + '%').all();
  ok(bound.results.length === 5, '[' + label + '] LIKE ? 绑定参数前缀查询', String(bound.results.length));

  /* test_ 前缀(后台存储测试按钮用到) */
  await db.prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
    .bind('test_' + Date.now(), 't', now + 3600).run();
  const testList = await db.prepare('SELECT key, value FROM kv_store WHERE key LIKE ?').bind('test_' + '%').all();
  ok(testList.results.length === 1, '[' + label + '] test_ 前缀索引查询(后台存储测试)', String(testList.results.length));

  await db.prepare('DELETE FROM kv_store WHERE key = ?').bind('parse_record_005').run();
  const cntAfter = await db.prepare("SELECT COUNT(*) as cnt FROM kv_store WHERE key LIKE 'parse_record_%'").first();
  ok(cntAfter.cnt === 4, '[' + label + '] DELETE key 后计数 = 4');
  await db.prepare('DELETE FROM kv_store WHERE expires_at > 0 AND expires_at < ?').bind(now).run();
  const expGone = await db.prepare('SELECT value, expires_at FROM kv_store WHERE key = ?').bind('login:expired').first();
  ok(expGone === null, '[' + label + '] 过期清理删除已过期行');

  /* short_links 家族 */
  const dup = await db.prepare('SELECT shortcode FROM short_links WHERE shortcode = ?').bind('ab12cd').first();
  ok(dup === null, '[' + label + '] 短链不存在时 first() 返回 null');
  await db.prepare("INSERT INTO short_links (shortcode, original_url, created_at) VALUES (?, ?, strftime('%s', 'now'))")
    .bind('ab12cd', 'https://jx.example.com/?url=https%3A%2F%2Fpan.quark.cn%2Fs%2Fxyz&fid=1').run();
  const sl = await db.prepare('SELECT * FROM short_links WHERE shortcode = ?').bind('ab12cd').first();
  ok(sl && sl.original_url.indexOf('pan.quark.cn') !== -1 && sl.access_count === 0, '[' + label + '] 短链插入/查询', JSON.stringify(sl));
  await db.prepare("UPDATE short_links SET access_count = access_count + 1, last_accessed = strftime('%s', 'now') WHERE shortcode = ?").bind('ab12cd').run();
  const sl2 = await db.prepare('SELECT * FROM short_links WHERE shortcode = ?').bind('ab12cd').first();
  ok(sl2.access_count === 1, '[' + label + '] 短链访问计数 +1');

  /* records_stats_cache 家族 */
  const stats0 = await db.prepare("SELECT cache_key, cache_value, updated_at FROM records_stats_cache WHERE cache_key IN ('stats_success_total', 'stats_failed_total', 'stats_total')").all();
  ok(stats0.results.length === 3 && stats0.results.every(r => r.cache_value === '0'), '[' + label + '] 统计缓存初始 3 行', JSON.stringify(stats0.results));
  await db.prepare("INSERT OR REPLACE INTO records_stats_cache (cache_key, cache_value, updated_at) VALUES ('stats_success_total', ?, ?)").bind('41', now).run();
  await db.prepare("INSERT OR REPLACE INTO records_stats_cache (cache_key, cache_value, updated_at) VALUES ('stats_failed_total', ?, ?)").bind('2', now).run();
  await db.prepare("INSERT OR REPLACE INTO records_stats_cache (cache_key, cache_value, updated_at) VALUES ('stats_total', ?, ?)").bind('43', now).run();
  await db.prepare('UPDATE records_stats_cache SET cache_value = CAST(cache_value AS INTEGER) + 1, updated_at = ? WHERE cache_key = ?').bind(now, 'stats_success_total').run();
  const stats1 = await db.prepare("SELECT cache_key, cache_value, updated_at FROM records_stats_cache WHERE cache_key IN ('stats_success_total', 'stats_failed_total', 'stats_total')").all();
  const succ = stats1.results.find(r => r.cache_key === 'stats_success_total');
  ok(succ && succ.cache_value === '42', '[' + label + '] 统计增量 UPDATE 后 41+1=42', JSON.stringify(succ));

  /* 300 key 大数据量(跨页/索引压力) */
  for (let i = 0; i < 300; i++) {
    await db.prepare('INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)')
      .bind('page_test_' + String(i).padStart(4, '0'), 'v' + i, 0).run();
  }
  const bigCnt = await db.prepare("SELECT COUNT(*) as cnt FROM kv_store WHERE key LIKE 'page_test_%'").first();
  const expected = label === 'EdgeOne' ? 300 : 0;   // ESA 无索引的非解析记录前缀返回空(文档化限制)
  ok(bigCnt.cnt === expected, '[' + label + '] page_test_ 300 key 计数 = ' + expected, JSON.stringify(bigCnt));
}

/* ================= Phase A: EdgeOne 模式 ================= */
console.log('===== Phase A: EdgeOne 模式(原生 list KV) =====');
const mockKV = new MockKV();
globalThis.jxpan = mockKV;

const mod = await import(bundleURL);
ok(typeof mod.onRequest === 'function', 'bundle 导出 onRequest');
ok(typeof mod.default === 'object' && typeof mod.default.fetch === 'function', 'bundle 导出 default.fetch(ESA/CF Workers)');

async function req(url, init) {
  const r = new Request(url, init);
  const env = { admin: 'admin', pass: 'admin' };
  return mod.onRequest({ request: r, env, params: {} });
}

const home = await req('https://jx.example.com/');
ok(home.status === 200, 'GET / 返回 200', 'status=' + home.status);
ok(/<html|<!DOCTYPE/i.test(await home.text()), 'GET / 返回 HTML 页面');
const adminPage = await req('https://jx.example.com/admin');
ok(adminPage.status === 200, 'GET /admin 返回 200', 'status=' + adminPage.status);

let badParseErr = null;
try {
  const badParse = await req('https://jx.example.com/json/parser?url=https://example.com/not-a-pan');
  const badJson = await badParse.json().catch(() => null);
  ok(badJson !== null && typeof badJson === 'object', 'GET /json/parser 无效链接返回 JSON', JSON.stringify(badJson).slice(0, 120));
} catch (e) {
  badParseErr = e;
  ok(!/EO-KV适配|不支持的 SQL/.test(String(badParseErr && badParseErr.message)),
    '无效链接的报错非适配层产生(与 CF 行为一致)', String(badParseErr && badParseErr.message).slice(0, 120));
}

const opts = await req('https://jx.example.com/json/parser', { method: 'OPTIONS' });
ok(opts.status === 204, 'OPTIONS 预检返回 204', 'status=' + opts.status);

const eo = globalThis.__EO_JXPAN__;
const shimEnvA = eo.eoAttachShim({});
ok(shimEnvA.jxpan && shimEnvA.jxpan.__isEOD1Shim, '全局 jxpan 绑定被识别并挂载为 D1 shim');
ok(eo.eoResolveProvider({}).__kind === 'edgeone', 'EdgeOne 模式 provider 识别');
await storageSuite('EdgeOne', shimEnvA.jxpan);

/* 短链 HTTP 全链路 */
console.log('\n-- 短链 HTTP 流程 --');
const shortReq = await req('https://jx.example.com/api/create-short', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'https://jx.example.com/?url=https%3A%2F%2Fpan.quark.cn%2Fs%2Ftest123' })
});
const shortJson = await shortReq.json().catch(() => null);
ok(shortJson && (shortJson.code === 200 || shortJson.success), 'POST /api/create-short 成功', JSON.stringify(shortJson).slice(0, 150));
const shortCode = shortJson && (shortJson.shortcode || (shortJson.data && (shortJson.data.shortcode || shortJson.data.short_url)));
if (shortCode) {
  const code = String(shortCode).split('/').pop();
  const slRes = await req('https://jx.example.com/s/' + code);
  ok([301, 302, 200].includes(slRes.status), 'GET /s/<code> 可访问', 'status=' + slRes.status);
} else {
  ok(false, '未从 create-short 响应中取到短链码', JSON.stringify(shortJson).slice(0, 150));
}

let rejected = false;
try { await mockKV.put('bad:key:https://x', 'v'); } catch (e) { rejected = true; }
ok(rejected, 'MockKV 拒绝含冒号的 key(印证必须编码)');

/* ================= Phase B: ESA 模式 ================= */
console.log('\n===== Phase B: 阿里云 ESA 模式(EdgeKV 无 list, 索引桶) =====');
delete globalThis.jxpan;                       // 摘掉 EdgeOne 绑定, 避免抢先命中
esaStore = new Map();
globalThis.EdgeKV = MockEdgeKV;

const shimEnvB = eo.eoAttachShim({});
ok(shimEnvB.jxpan && shimEnvB.jxpan.__isEOD1Shim, 'EdgeKV 全局类被识别并挂载为 D1 shim');
const provB = eo.eoResolveProvider({});
ok(provB && provB.__kind === 'esa', 'ESA 模式 provider 识别', provB && provB.__kind);
ok(provB && provB.namespace === 'jxpan', '默认 EdgeKV 命名空间 = jxpan');

/* 通过 ESA 的 default.fetch 入口分发(不经过 onRequest) */
async function reqEsa(url, init) {
  const r = new Request(url, init);
  return mod.default.fetch(r, { admin: 'admin', pass: 'admin' }, undefined);
}
const homeB = await reqEsa('https://jx.example.com/');
ok(homeB.status === 200, 'ESA default.fetch: GET / 返回 200', 'status=' + homeB.status);
const adminB = await reqEsa('https://jx.example.com/admin');
ok(adminB.status === 200, 'ESA default.fetch: GET /admin 返回 200', 'status=' + adminB.status);

await storageSuite('ESA', shimEnvB.jxpan);

/* ESA: 删除记录后索引同步(count 变化) */
const esaStoreRef = esaStore;
const beforeDel = await shimEnvB.jxpan.prepare("SELECT COUNT(*) as cnt FROM kv_store WHERE key LIKE 'parse_record_%'").first();
await shimEnvB.jxpan.prepare('DELETE FROM kv_store WHERE key = ?').bind('parse_record_004').run();
const afterDel = await shimEnvB.jxpan.prepare("SELECT COUNT(*) as cnt FROM kv_store WHERE key LIKE 'parse_record_%'").first();
ok(afterDel.cnt === beforeDel.cnt - 1, 'ESA: DELETE 后索引同步, 计数 -1', beforeDel.cnt + ' -> ' + afterDel.cnt);
ok(esaStoreRef.size > 0, 'ESA: 数据写入 mock EdgeKV(' + esaStoreRef.size + ' keys)');

console.log('\n================================');
console.log('通过 ' + passed + ' / 失败 ' + failed);
process.exit(failed > 0 ? 1 : 0);
