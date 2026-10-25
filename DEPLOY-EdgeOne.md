# JxPan · 腾讯 EdgeOne Pages 版

把 [ByLsPro/JxPan](https://github.com/ByLsPro/JxPan)(原 Cloudflare Workers + D1)移植到 **腾讯 EdgeOne Pages 边缘函数 + KV 存储**,功能不变:网盘直链解析、JSON 输出、302 跳转、短链、后台扫码登录、解析记录与统计。

> 适配原因:EdgeOne 没有 Cloudflare D1(SQL 数据库),本项目把 JxPan 用到的
> 十余条固定 SQL 全部翻译成了 EdgeOne KV 的 get/put/delete/list 操作,
> JxPan 主代码零改动(仍基于 `未加密源码.js`)。

## 文件说明

```
jxpan-edgeone/
├── functions/
│   └── [[default]].js     ← 部署物:JxPan 源码 + KV 适配层(单文件全捕获路由)
├── src/
│   └── eo-shim.js         ← 适配层源码(D1 SQL → EdgeOne KV)
├── JxPan/                 ← 上游源码副本(构建输入,含 LICENSE)
├── build.mjs              ← 重新构建脚本(上游更新时用)
├── test/
│   └── mock-kv.test.mjs   ← 本地冒烟测试(31 项,模拟 EdgeOne KV 语义)
└── DEPLOY-EdgeOne.md      ← 本文档
```

## 部署步骤

### 1. 创建 EdgeOne Pages 项目

把本目录推到一个 Git 仓库(GitHub / Gitee 均可),然后:

1. 登录腾讯云控制台,进入 **EdgeOne Pages(或 Makers)**
2. **创建项目 → 导入 Git 仓库**,选择刚推送的仓库
3. 构建配置:**构建命令留空,输出目录填 `/`**(本项目无前端构建,`functions/` 目录会被平台自动识别为边缘函数)
4. 部署完成后会得到 `*.edgeone.app` / `*.edgeone.run` 预览域名

> 也可以用官方 CLI 本地调试:`npm install -g edgeone` → `edgeone pages init` → `edgeone pages dev` → `edgeone pages link`。

### 2. 绑定 KV 存储(必需,变量名必须是 `jxpan`)

JxPan 把登录凭据、解析记录、统计、短链全存在原来的 D1 里,移植后存到 KV:

1. 控制台进入 **存储 → KV**,申请开通,然后 **创建命名空间**(名字随意,如 `jxpan`)
2. 进入 **项目详情 → KV 存储 → 绑定命名空间**,选择刚才的命名空间
3. **变量名填写 `jxpan`**(适配层按这个名字查找,也兼容 `jxpan_kv` / `JXPAN_KV` / `KV`)

不绑 KV 时服务仍可运行,但仅直链解析可用,凭据保存 / 记录 / 统计 / 短链不可用。

### 3. 配置环境变量(按需)

进入 **项目详情 → 环境变量**,变量名与 CF 版完全一致:

| 变量名 | 说明 |
| --- | --- |
| `admin` / `pass` | 后台 `/admin` 登录账号密码(建议必配) |
| `QK_COOKIE` | 夸克网盘 Cookie |
| `UC_COOKIE` | UC 网盘 Cookie |
| `ALIYUN_AUTHORIZATION` | 阿里云盘 Token |
| `MCLOUD_AUTHORIZATION` | 移动云盘 Token |
| `CLOUD189_TOKEN` | 天翼云盘 AccessToken |
| `PAN123_TOKEN` | 123 云盘 Token |
| `GY_Login` | 光鸭云盘登录 JSON |

更推荐部署后在 `/admin` 后台用**扫码登录**配置,凭据会加密存进 KV(优先级:扫码 > 手输 > 环境变量)。

### 4. 验证

- 访问 `https://你的域名/` → 应显示解析页面
- 访问 `https://你的域名/admin` → 应显示后台登录页
- 解析测试:`https://你的域名/?url=<分享链接>`
- 短链:`POST /api/create-short` → `GET /s/<短链码>`

### 5. 绑定自定义域名(可选)

项目详情 → 域名管理 → 添加自定义域名,按提示加 CNAME 记录。

## 与 Cloudflare 版的差异

| 事项 | Cloudflare 版 | 本 EdgeOne 版 |
| --- | --- | --- |
| 数据库 | D1(SQL) | EdgeOne KV,SQL 由适配层翻译 |
| key 限制 | 任意字符串 | KV 只允许数字/字母/下划线 → 适配层对 key 做 UTF-8 hex 编码(保序,前缀查询/排序语义不变),业务层无感知 |
| 过期机制 | D1 `expires_at` 列 | 过期时间存进 KV value,读取时校验并惰性删除 |
| 一致性 | D1 强一致 | KV 最终一致:极高并发下统计计数可能少量丢失,不影响解析功能 |
| 入口 | `export default { fetch }` | `functions/[[default]].js` 导出 `onRequest(context)`(文件内同时保留 `default` 导出,这份文件**也可直接当 CF Workers 用**) |
| 出口 IP | Cloudflare 边缘 | 腾讯 EdgeOne 边缘(国内节点,对国内网盘风控更友好) |

## 本地验证

```bash
node test/mock-kv.test.mjs    # 31 项冒烟测试,覆盖 JxPan 全部 SQL 家族
```

测试覆盖:页面路由分发、建表兼容、kv_store 读写/过期/特殊字符 key、解析记录前缀查询(DESC + LIMIT/OFFSET + 跨 KV 分页)、短链增查计数、统计缓存增量更新、`/api/create-short` 全链路。

## 重新构建(上游 JxPan 更新时)

```bash
git clone https://github.com/ByLsPro/JxPan
# 把 JxPan/未加密源码.js 更新到本目录 JxPan/ 下,然后:
node build.mjs
```

构建脚本会把 `export default {` 入口改名为内部常量,再拼接适配层;若上游代码结构大改(如出现新的 SQL 语句),适配层会抛出 `[EO-KV适配] 不支持的 SQL: ...`,把该 SQL 补进 `src/eo-shim.js` 的路由表即可。

## 注意事项

- KV 免费额度:单账户容量 1GB、10 个命名空间,解析记录建议定期在后台清理(适配层的过期清理已就绪)
- JxPan 原项目免责声明同样适用:仅供学习交流,高频调用会触发网盘风控,账号封禁风险自担
- 上游协议 MIT,本移植沿用
