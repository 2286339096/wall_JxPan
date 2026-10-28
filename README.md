# JxPan纯解析版（腾讯 EdgeOne Pages /阿里云 ESA）

基于 [ByLsPro/JxPan](https://github.com/ByLsPro/JxPan)的纯解析移植版，作为 OpenList /壁纸站的分享链接解析中间层使用。

这个版本**不需要 KV、不需要 EdgeKV、不需要 D1，也不需要远程数据库**，部署时也**不需要 Git仓库**。JxPan原版的扫码登录、后台、解析记录、统计与短链功能已关闭；只保留分享链接解析。

## 可用功能

- 网盘分享链接解析
- 首页解析界面
- JSON接口：`/json/parser?url=...`，也兼容 `/?url=...&type=json`
- 302下载：`/?url=...&type=down`（并非所有网盘都支持302）
- 通过环境变量提供网盘凭证

支持：阿里云盘、夸克、UC、移动云盘、天翼云盘、123云盘、小飞机、蓝奏云 /蓝奏云优享版、光鸭、豆包云盘。具体能否解析仍受网盘风控、分享链接类型及凭证状态影响。

## 已关闭功能

- `/admin`后台与账号密码登录
- 扫码登录、登录状态与 Token保存
- 解析记录、统计、缓存持久化
- `/api/create-short`与 `/s/:code`短链

这些路由会直接返回 `404`，不会尝试连接任何存储。正常解析请求也不会调用 KV/D1。

## 部署

见 [DEPLOY.md](DEPLOY.md)。直接上传 `jxpan-edgeone-parse-only.zip`或使用 EdgeOne CLI部署，无需 Git仓库。两个平台使用不同的入口文件名：

-腾讯 EdgeOne Pages：`edge-functions/[[...default]].js`
-阿里云 ESA：`functions/[[default]].js`

两种入口都导出 `onRequest(context)`与 `default.fetch(request, env, ctx)`。

```text
functions/[[default]].js # ESA入口 bundle
edge-functions/[[...default]].js # EdgeOne全路径入口 bundle
index.html #纯解析首页
src/eo-shim.js #纯解析入口与禁用路由
test/parse-only.test.mjs #无存储冒烟测试
build.mjs #上游更新后重新生成 bundle
JxPan/ #上游未加密源码与 LICENSE
```

## 本地验证

需要 Node.js18或更高版本：

```powershell
cd E:\web_APP\openlist_wallpic\jxpan-edgeone-parse-only
node test/parse-only.test.mjs
```

测试会检查首页、入口、禁用路由、POST表单禁用 action，并确认解析流程没有调用模拟的 KV。

## 重新构建

替换 `JxPan/未加密源码.js`后运行：

```powershell
node build.mjs
```

构建会同时生成 `functions/`、`edge-functions/`和只含运行文件的 `deploy-edgeone/`。**不要把仓库根目录直接上传到 EdgeOne**，否则源码、文档和 ZIP文件可能被当作静态资源公开。

## 说明

本项目沿用上游 MIT协议，仅供个人学习与技术交流。高频调用可能触发网盘风控，账号风险自担。
