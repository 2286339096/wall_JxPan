# wall_JxPan · JxPan 网盘解析(EdgeOne Pages / 阿里云 ESA 双平台版)

基于 [ByLsPro/JxPan](https://github.com/ByLsPro/JxPan) 移植,同一份代码运行在 **腾讯 EdgeOne Pages** 或 **阿里云 ESA 边缘函数**上,不再依赖 Cloudflare Workers / D1。

- 功能不变:网盘直链解析、JSON API、302 跳转、短链、后台扫码登录、解析记录与统计
- 支持网盘:阿里云盘 / 夸克 / UC / 移动 / 天翼 / 123 / 小飞机 / 蓝奏云(优享) / 光鸭

**部署方法见 [DEPLOY.md](DEPLOY.md)** —— EdgeOne 绑定 KV 变量名 `jxpan`;ESA 创建 EdgeKV 存储空间 `jxpan` 后把 `functions/[[default]].js` 粘贴进函数即可,适配层自动识别平台。

## 仓库结构

```
functions/[[default]].js   ← 部署物(双平台入口 onRequest + default.fetch,含存储适配层)
src/eo-shim.js             ← 适配层源码(D1 SQL → EdgeOne KV / ESA EdgeKV)
build.mjs                  ← 上游更新后重新构建
test/mock-kv.test.mjs      ← 本地冒烟测试(node test/mock-kv.test.mjs,双平台 59 项)
JxPan/                     ← 上游未加密源码与 LICENSE(构建输入)
```

## 本地验证

```bash
node test/mock-kv.test.mjs   # EdgeOne 模式 + ESA 模式各跑一遍全部 SQL 家族
```

## 声明

沿用上游 MIT 协议,仅供个人学习与技术交流;高频调用会触发网盘风控,账号风险自担。
