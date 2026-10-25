/**
 * JxPan EdgeOne 构建脚本
 * 把 JxPan 未加密源码 + EdgeOne KV 适配层合并为 functions/[[default]].js
 *
 * 用法:
 *   1. 克隆 JxPan:  git clone https://github.com/ByLsPro/JxPan
 *   2. 修改下方 JXPAN_SRC 指向其中的 未加密源码.js
 *   3. node build.mjs
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
  console.error('未找到 未加密源码.js, 请先 git clone https://github.com/ByLsPro/JxPan 或设置 JXPAN_SRC 环境变量');
  process.exit(1);
}

const shim = fs.readFileSync(path.join(here, 'src', 'eo-shim.js'), 'utf8');
let src = fs.readFileSync(srcPath, 'utf8');

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

const out = src + '\n\n' + shim + '\n';
const outDir = path.join(here, 'functions');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '[[default]].js'), out);

console.log('构建完成: functions/[[default]].js  (' + (out.length / 1024).toFixed(0) + ' KB)');
console.log('源文件: ' + srcPath);
