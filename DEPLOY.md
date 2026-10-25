# 部署指南(腾讯 EdgeOne Pages / 阿里云 ESA)

同一份 `functions/[[default]].js`(JxPan 源码 + 多平台存储适配层)可运行在三个平台:

| 平台 | 入口 | 存储 | 部署方式 |
| --- | --- | --- | --- |
| 腾讯 EdgeOne Pages | `onRequest(context)`(functions 目录全捕获) | EdgeOne KV(原生 list) | Git 导入 |
| 阿里云 ESA 边缘函数 | `default.fetch(request, env, ctx)` | EdgeKV(无 list,适配层自动建索引) | 控制台粘贴/上传 |
| Cloudflare Workers/Pages | `default.fetch` / `onRequest` | 需自行绑定 | 原有方式 |

适配层按环境自动选择存储后端,代码无需任何修改:
有 `list` 能力的 KV 绑定(EdgeOne)→ 直查前缀;发现全局 `EdgeKV` 类(ESA)→ 启用按天索引桶;都没有 → 无存储模式(仅解析可用)。

---

## 一、腾讯 EdgeOne Pages

### 1. 创建项目
把本仓库推到 GitHub/Gitee → EdgeOne 控制台(Makers/Pages)→ **创建项目 → 导入 Git 仓库**;构建命令留空,输出目录填 `/`。

### 2. 绑定 KV(变量名必须是 `jxpan`)
控制台 **存储 → KV** 开通并创建命名空间(如 `jxpan`)→ 项目详情 → **KV 存储 → 绑定命名空间**,变量名填 `jxpan`(也兼容 `jxpan_kv`/`JXPAN_KV`/`KV`)。

### 3. 环境变量
项目详情 → 环境变量,变量名与 CF 版一致(`admin`/`pass`/`QK_COOKIE`/`UC_COOKIE`/`ALIYUN_AUTHORIZATION`/`MCLOUD_AUTHORIZATION`/`CLOUD189_TOKEN`/`PAN123_TOKEN`/`GY_Login`)。推荐部署后在 `/admin` 后台扫码登录配置。

### 4. 验证
访问 `https://你的域名/` 显示解析页、`/admin` 显示后台登录页即成功。

## 二、阿里云 ESA(边缘函数 / Pages)

### 方式 A:ESA Pages + Git 导入(推荐,与 EdgeOne 同样省事)
1. ESA 控制台 → **边缘计算和 AI → 函数和 Pages → 创建 Pages → 导入 Git 仓库**,选择本仓库
2. 仓库根目录已带 `esa.jsonc`(声明函数入口 `./functions/[[default]].js`,并跳过安装/构建步骤,纯函数项目无需 npm)
3. 部署完成后绑定域名即可访问

### 方式 B:控制台创建边缘函数(ER)
1. ESA 控制台 → **函数和 Pages → 创建函数** → 代码编辑器里粘贴/上传 `functions/[[default]].js` 完整内容(约 1.85MB,低于 4MB 代码包上限)
2. 生成版本并发布;通过 **域名绑定** 或 **路由** 把流量指向该函数

### 开通边缘 KV 并创建存储空间(两种方式都需要)
控制台 **边缘存储(EdgeKV)** 开通后 **创建存储空间**,名称默认 `jxpan`。
若用了别的名字,添加函数变量 `EO_KV_NAMESPACE = <存储空间名>` 即可,无需改代码。

### 配置函数变量(环境变量)
函数详情 → **基本信息 → 函数变量**(分生产/测试环境,支持加密存储):`admin`、`pass`、`QK_COOKIE` 等,与 EdgeOne 相同。**修改变量后需重新生成版本并发布才会生效**(版本绑定变量快照)。

### 验证
访问函数/Pages 绑定的域名:首页显示解析页、`/admin` 显示后台登录页即成功。

### ESA 平台的已知限制
| 限制 | 影响 |
| --- | --- |
| **单次执行子请求(fetch)最多 4 个** | 单文件解析通常 2~4 个请求没问题;多级文件夹遍历、多域名重试流程可能超限失败 |
| EdgeKV 无 `list()` | 适配层用按天索引桶实现解析记录分页/计数,回扫 60 天;更早的记录在后台不可见 |
| 单值上限 1.8MB | 解析记录远小于此,无实际影响 |
| 索引桶读-改-写 | 同一秒内并发解析可能丢个别记录(仅影响后台记录列表,不影响解析) |
| 代码包 4MB | 当前 bundle 1.85MB,余量充足 |

---

## 本地验证

```bash
node test/mock-kv.test.mjs    # 59 项冒烟测试: EdgeOne 模式 + ESA 模式各跑一遍全部 SQL 家族
```

## 重新构建(上游 JxPan 更新时)

```bash
git clone https://github.com/ByLsPro/JxPan
# 把 JxPan/未加密源码.js 更新到本仓库 JxPan/ 下,然后:
node build.mjs
```

适配层只会翻译 JxPan 已知的 21 种固定 SQL;若上游出现新 SQL,运行时会抛 `[EO-KV适配] 不支持的 SQL: ...`,把该语句补进 `src/eo-shim.js` 的路由表即可。

## 注意事项

- JxPan 原项目免责声明同样适用:仅供学习交流,高频调用会触发网盘风控,账号风险自担
- 上游协议 MIT,本移植沿用
