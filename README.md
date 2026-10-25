# wall_JxPan · JxPan 网盘解析(腾讯 EdgeOne Pages 版)

基于 [ByLsPro/JxPan](https://github.com/ByLsPro/JxPan) 移植,运行在 **腾讯 EdgeOne Pages 边缘函数 + KV 存储**上,不再依赖 Cloudflare Workers / D1。

- 功能不变:网盘直链解析、JSON API、302 跳转、短链、后台扫码登录、解析记录与统计
- 支持网盘:阿里云盘 / 夸克 / UC / 移动 / 天翼 / 123 / 小飞机 / 蓝奏云(优享) / 光鸭

**部署方法、KV 绑定(变量名必须为 `jxpan`)、环境变量配置见 [DEPLOY-EdgeOne.md](DEPLOY-EdgeOne.md)。**

## 仓库结构

```
functions/[[default]].js   ← 部署物(边缘函数全捕获入口,含 D1→KV 适配层)
src/eo-shim.js             ← 适配层源码(EdgeOne 无 D1,SQL 翻译为 KV 操作)
build.mjs                  ← 上游更新后重新构建
test/mock-kv.test.mjs      ← 本地冒烟测试(node test/mock-kv.test.mjs)
JxPan/                     ← 上游未加密源码与 LICENSE(构建输入)
```

## 本地验证

```bash
node test/mock-kv.test.mjs   # 31 项冒烟测试
```

## 声明

沿用上游 MIT 协议,仅供个人学习与技术交流;高频调用会触发网盘风控,账号风险自担。
