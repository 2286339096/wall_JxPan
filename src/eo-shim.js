/* =====================================================================
 * JxPan pure-parse entry shim.
 *
 * This build deliberately never mounts KV, D1 or EdgeKV.
 * Only direct-link parsing is available.
 * ===================================================================== */

(function () {
 'use strict';

 function withoutStorage(env) {
 const source = (env && typeof env === 'object') ? env : {};
 const result = {};
 for (const key of Object.keys(source)) {
 if (key !== 'jxpan') result[key] = source[key];
 }
 return result;
 }

function eoAttachShim(env) {
return withoutStorage(env);
}

 globalThis.__EO_JXPAN__ = { eoAttachShim: eoAttachShim };
})();

/* ===================== Entry adapters =====================
 * EdgeOne Pages / CF Pages: onRequest(context)
 * Aliyun ESA / CF Workers: export default { fetch(request, env, ctx) }
 * ============================================================ */

const DISABLED_ACTIONS = new Set([
 'get_stats',
 'get_records',
 'get_success_records',
 'get_failed_records',
 'search_records',
 'count_records',
 'list_parse_records',
 'delete_record',
 'delete_batch_records',
 'clear_all_records',
 'cancel_clear',
 'test_kv',
 'doubao_biz_auth',
 'doubao_oauth_callback'
]);

function isDisabledAction(action) {
 if (!action) return false;
 if (DISABLED_ACTIONS.has(action)) return true;
 return /(?:^|_)(?:login|logout|status|check|manual_save)$/.test(action) ||
 /(?:_qrcode|_qr_poll|_qr_save)$/.test(action);
}

const HOME_PAGE = __JXPAN_HOME_PAGE__;

function disabledFeatureResponse(message) {
 return new Response(JSON.stringify({
 code:404,
 msg: message,
 success: false,
 data: null
 }), {
 status:404,
 headers: {
 'Content-Type': 'application/json; charset=utf-8',
 'Access-Control-Allow-Origin': '*'
 }
 });
}

function parseOnlyResponse(url, action) {
const blockedPath = url.pathname === '/admin' ||
url.pathname.startsWith('/admin/') ||
url.pathname === '/api/create-short' ||
url.pathname.startsWith('/s/');
const blockedAction = isDisabledAction(action || url.searchParams.get('action') || '');
const blocked = blockedPath || blockedAction;

if (!blocked) return null;

 return disabledFeatureResponse(blockedAction
 ? 'Login, records and statistics are disabled in parse-only mode'
 : 'This feature is disabled in parse-only mode');
}

function makeCtx(ctx) {
 if (ctx && typeof ctx.waitUntil === 'function') return ctx;
 return {
 waitUntil(p) {
 try {
 if (p && typeof p.then === 'function') p.then(function () {}, function () {});
 } catch (err) { /* ignore */ }
 }
};
}

async function readFormAction(request) {
 if (request.method !== 'POST') return '';
 const contentType = (request.headers.get('content-type') || '').toLowerCase();
 if (!contentType.includes('application/x-www-form-urlencoded') &&
 !contentType.includes('multipart/form-data')) {
 return '';
 }

 try {
 const body = await request.clone().text();
 if (!body) return '';

 if (contentType.includes('application/x-www-form-urlencoded')) {
 return new URLSearchParams(body).get('action') || '';
 }

 if (contentType.includes('multipart/form-data')) {
 const form = await request.clone().formData();
 const value = form.get('action');
 return typeof value === 'string' ? value : '';
 }
 } catch (err) {
 console.log('[parse-only] unable to inspect POST body:', err && err.message ? err.message : err);
 }

 return '';
}

async function handle(request, env, ctx) {
if (!request) {
return new Response('Bad Request', { status:400 });
}

const url = new URL(request.url);
 if (request.method === 'OPTIONS') {
 return new Response(null, {
 status:204,
 headers: {
 'Access-Control-Allow-Origin': '*',
 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
 'Access-Control-Allow-Headers': 'Content-Type, Authorization'
 }
 });
 }
const purePagePaths = new Set(['/', '/index.html']);
if ((request.method === 'GET' || request.method === 'HEAD') &&
purePagePaths.has(url.pathname) && !url.searchParams.has('url')) {
 return new Response(HOME_PAGE, {
status:200,
headers: {
'Content-Type': 'text/html; charset=utf-8',
 'Cache-Control': 'public, max-age=3600',
'X-JxPan-Mode': 'parse-only'
}
});
 }

const formAction = await readFormAction(request);
const blocked = parseOnlyResponse(url, formAction);
if (blocked) {
blocked.headers.set('X-JxPan-Mode', 'parse-only');
return blocked;
}

const parsePath = url.pathname === '/json/parser' || url.pathname === '/';
 if (!parsePath || !url.searchParams.has('url')) {
 return disabledFeatureResponse('Not found in parse-only mode');
 }

const cleanEnv = globalThis.__EO_JXPAN__.eoAttachShim(env || {});
try {
return await __JXPAN_WORKER.fetch(request, cleanEnv, makeCtx(ctx));
} catch (err) {
console.error('[parse-only] request failed:', err);
return new Response(JSON.stringify({
code:500,
msg: 'Parse request failed',
success: false,
data: null
}), {
status:500,
headers: {
'Content-Type': 'application/json; charset=utf-8',
'Access-Control-Allow-Origin': '*'
}
});
}
}

export async function onRequest(context) {
 return handle(context && context.request, context && context.env, context && context.ctx);
}

export default {
 async fetch(request, env, ctx) {
 return handle(request, env, ctx);
 }
};
