/**
 * JxPan EdgeOne 构建脚本
 *把 JxPan未加密源码 +纯解析入口适配层合并为 functions/[[default]].js
 *
 * 用法:
 *1.将 JxPan未加密源码放入 JxPan/未加密源码.js
 *2.或通过 JXPAN_SRC指向该文件
 *3. node build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/* 源文件候选路径: 本地 JxPan 目录优先 */
const candidates = [
  path.join(here, 'JxPan', '未加密源码.js'),
  path.join(here, '..', 'JxPan', '未加密源码.js'),
  process.env.JXPAN_SRC || '',
].filter(Boolean);

let srcPath = null;
for (const c of candidates) {
  if (fs.existsSync(c)) { srcPath = c; break; }
}

if (!srcPath) {
 console.error('未找到未加密源码.js，请放入 JxPan目录或设置 JXPAN_SRC环境变量');
 process.exit(1);
}

const homePage = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const shim = fs
 .readFileSync(path.join(here, 'src', 'eo-shim.js'), 'utf8')
 .replace('__JXPAN_HOME_PAGE__', JSON.stringify(homePage));
let src = fs.readFileSync(srcPath, 'utf8');

if (shim.includes('__JXPAN_HOME_PAGE__')) {
 throw new Error('首页注入失败，请检查 src/eo-shim.js中的页面占位符');
}

/* Cloudflare Workers 的 export default 入口改名为内部常量,
 * 由适配层的 onRequest(context) 调用; 同时保留 default 导出兼容 CF */
const MARK = 'export default {';
if (!src.includes(MARK)) {
  console.error('源码中未找到 "export default {" 入口, 文件可能已更新, 请检查');
  process.exit(1);
}
const occurrences = src.split(MARK).length - 1;
if (occurrences > 1) throw new Error('发现 ' + occurrences + ' 处 export default, 需人工确认替换位置');
src = src.replace(MARK, 'const __JXPAN_WORKER = {');

/* 防止源码里出现同名全局 */
if (/__JXPAN_WORKER/.test(src.replace('const __JXPAN_WORKER = {', ''))) {
  throw new Error('源码中已存在 __JXPAN_WORKER 标识符');
}

/*隐藏上游首页底部的源码仓库链接，不修改 JxPan原始文件。 */
const upstreamFooterLink =
 '<a href="https://github.com/ByLsPro/JxPan/" target="_blank" class="text-primary hover:text-primary/80 transition-colors"><i class="fa fa-github mr-1"></i>GitHub项目</a><span class="text-secondary">|</span>';
if (!src.includes(upstreamFooterLink)) {
 throw new Error('未找到上游首页 GitHub链接，源码结构可能已变化');
}
src = src.replace(upstreamFooterLink, '');

/* EdgeOne's esbuild pass rejects these upstream const reassignments. */
const constFixes = [
 [
 'const cookies = `COOKIE_LOGIN_USER=${this.cookieLoginUser}`;',
 'let cookies = `COOKIE_LOGIN_USER=${this.cookieLoginUser}`;'
 ],
 [
 "const frontendIlanzouAccount = params['ilanzou_account'] || url.searchParams.get('ilanzou_account') || '';",
 "let frontendIlanzouAccount = params['ilanzou_account'] || url.searchParams.get('ilanzou_account') || '';"
 ],
 [
 "const frontendFeijipanAccount = params['feijipan_account'] || url.searchParams.get('feijipan_account') || '';",
 "let frontendFeijipanAccount = params['feijipan_account'] || url.searchParams.get('feijipan_account') || '';"
 ]
];

for (const [from, to] of constFixes) {
 if (!src.includes(from)) {
 throw new Error('未找到待修复的上游常量声明: ' + from.slice(0,80));
 }
 src = src.split(from).join(to);
}

const out = src + '\n\n' + shim + '\n';
const outDir = path.join(here, 'functions');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '[[default]].js'), out);
const edgeOneOutDir = path.join(here, 'edge-functions');
fs.mkdirSync(edgeOneOutDir, { recursive: true });
fs.writeFileSync(path.join(edgeOneOutDir, '[[...default]].js'), out);

console.log('构建完成: functions/[[default]].js  (' + (out.length / 1024).toFixed(0) + ' KB)');
const deployDir = path.join(here, 'deploy-edgeone');
const deployFunctionsDir = path.join(deployDir, 'edge-functions');
fs.rmSync(deployDir, { recursive: true, force: true });
fs.mkdirSync(deployFunctionsDir, { recursive: true });
fs.copyFileSync(path.join(here, 'index.html'), path.join(deployDir, 'index.html'));
fs.writeFileSync(path.join(deployFunctionsDir, '[[...default]].js'), out);

console.log('源文件: ' + srcPath);
console.log('EdgeOne干净部署目录: deploy-edgeone/');
