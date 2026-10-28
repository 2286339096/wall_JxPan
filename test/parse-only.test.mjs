/**
 * Parse-only smoke test.
 *
 * Verifies that the bundle loads, both platform entries work, KV is never
 * mounted, and admin/short-link routes are unavailable.
 *
 * Run: node test/parse-only.test.mjs
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'functions', '[[default]].js');
const bundle = readFileSync(bundlePath, 'utf8');

let passed =0;
let failed =0;

function ok(condition, name, extra) {
 if (condition) {
 passed++;
 console.log(' OK ' + name);
 } else {
 failed++;
 console.log(' FAIL ' + name + (extra ? ' -- ' + extra : ''));
 }
}

const kvCalls = [];
const mockKV = {
 async get(key) { kvCalls.push(['get', key]); return null; },
 async put(key, value) { kvCalls.push(['put', key, value]); },
 async delete(key) { kvCalls.push(['delete', key]); },
 async list(options) { kvCalls.push(['list', options]); return { keys: [], complete: true }; }
};

globalThis.jxpan = mockKV;

const moduleUrl = pathToFileURL(bundlePath).href;
const mod = await import(moduleUrl);

ok(typeof mod.onRequest === 'function', 'bundle exports onRequest');
ok(typeof mod.default === 'object' && typeof mod.default.fetch === 'function',
 'bundle exports default.fetch');

const attached = globalThis.__EO_JXPAN__.eoAttachShim({
 jxpan: mockKV,
 QK_COOKIE: 'test-cookie'
});
ok(!attached.jxpan, 'eoAttachShim removes jxpan');
ok(attached.QK_COOKIE === 'test-cookie', 'eoAttachShim keeps env vars');

async function requestOnRequest(url, init) {
 return mod.onRequest({
 request: new Request(url, init),
 env: { jxpan: mockKV, admin: 'admin', pass: 'admin' }
 });
}

async function requestFetch(url, init) {
 return mod.default.fetch(
 new Request(url, init),
 { jxpan: mockKV, admin: 'admin', pass: 'admin' },
 undefined
 );
}

const home = await requestOnRequest('https://jx.example.com/');
ok(home.status ===200, 'GET / returns200', 'status=' + home.status);
const homeHtml = await home.text();
ok(/<html|<!DOCTYPE/i.test(homeHtml), 'GET / returns HTML');
ok(homeHtml.includes('JxPan分享链接解析'), 'home returns the pure parse page');
ok(!homeHtml.includes('github.com/ByLsPro/JxPan'), 'home does not link to upstream GitHub project');
ok(!bundle.includes('const cookies = `COOKIE_LOGIN_USER='), 'reassigned cookie variables are mutable');
ok(!bundle.includes("const frontendIlanzouAccount = params['ilanzou_account']"), 'ilanzou credential is mutable');
ok(!bundle.includes("const frontendFeijipanAccount = params['feijipan_account']"), 'feijipan credential is mutable');

const admin = await requestOnRequest('https://jx.example.com/admin');
ok(admin.status ===404, 'GET /admin returns404', 'status=' + admin.status);

const shortApi = await requestOnRequest('https://jx.example.com/api/create-short', {
 method: 'POST',
 headers: { 'content-type': 'application/json' },
 body: JSON.stringify({ url: 'https://jx.example.com/' })
});
ok(shortApi.status ===404, 'POST /api/create-short returns404', 'status=' + shortApi.status);

const shortLink = await requestOnRequest('https://jx.example.com/s/abc123');
ok(shortLink.status ===404, 'GET /s/<code> returns404', 'status=' + shortLink.status);

const options = await requestOnRequest('https://jx.example.com/json/parser', { method: 'OPTIONS' });
ok(options.status ===204, 'OPTIONS preflight returns204', 'status=' + options.status);

const invalid = await requestOnRequest(
 'https://jx.example.com/json/parser?url=https://example.com/not-a-pan'
);
const invalidJson = await invalid.json().catch(() => null);
ok(invalidJson && typeof invalidJson === 'object', 'invalid link returns JSON', JSON.stringify(invalidJson));

const formLogin = await requestOnRequest('https://jx.example.com/json/parser', {
 method: 'POST',
 headers: { 'content-type': 'application/x-www-form-urlencoded' },
 body: 'action=login_status&url=https%3A%2F%2Fexample.com%2Fnot-a-pan'
});
ok(formLogin.status ===404, 'form action is blocked: login_status', 'status=' + formLogin.status);

const esaHome = await requestFetch('https://jx.example.com/');
ok(esaHome.status ===200, 'default.fetch GET / returns200', 'status=' + esaHome.status);
const esaHomeHtml = await esaHome.text();
ok(esaHomeHtml.includes('JxPan分享链接解析'), 'default.fetch GET / returns parse page');

const esaAdmin = await requestFetch('https://jx.example.com/admin');
ok(esaAdmin.status ===404, 'default.fetch GET /admin returns404', 'status=' + esaAdmin.status);

for (const path of ['/README.md', '/build.mjs', '/jxpan-edgeone-parse-only.zip', '/JxPan/source.js']) {
 const response = await requestOnRequest('https://jx.example.com' + path);
 ok(response.status ===404, 'GET ' + path + ' returns404', 'status=' + response.status);
}

ok(kvCalls.length ===0, 'parse requests never call KV', JSON.stringify(kvCalls));

const storageActions = [
 'get_stats',
 'get_records',
 'test_kv',
 'list_parse_records',
 'quark_qrcode',
 'quark_qr_save',
 'aliyun_qrcode',
 'cloud189_qrcode',
 'pan123_login',
 'doubao_passport_qrcode',
 'guangya_qrcode',
 'doubao_biz_auth',
 'frontend_account_login',
 'login'
];

for (const action of storageActions) {
 const response = await requestOnRequest(
 'https://jx.example.com/json/parser?action=' + encodeURIComponent(action)
 );
 const body = await response.json().catch(() => null);
 ok(response.status ===404 &&
 body && body.success === false,
 'storage action blocked: ' + action,
 'status=' + response.status + ', body=' + JSON.stringify(body).slice(0,120));
}

console.log('\n================================');
console.log('passed ' + passed + ' / failed ' + failed);
process.exit(failed >0 ?1 :0);
