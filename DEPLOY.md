# 纯解析版部署指南

适用于腾讯 EdgeOne Pages与阿里云 ESA。这个版本不创建、不绑定任何存储，也不依赖 Git仓库：

| 项目 | 要求 |
| --- | --- |
| KV / EdgeKV / D1 | 不需要 |
| 远程数据库 /服务器后端 | 不需要 |
| Git仓库 / CI | 不需要 |
| EdgeOne入口 | `edge-functions/[[...default]].js` |
| ESA入口 | `functions/[[default]].js` |
| 必需配置 | 无；只有需要登录态解析的网盘才需设置相应环境变量 |

两个入口文件内容相同，都导出 `onRequest(context)`与 `default.fetch(request, env, ctx)`。当前约1.8 MB，低于常见边缘函数代码包限制。

## 一、腾讯 EdgeOne Pages

### 方式 A：控制台直接上传

1. 在 EdgeOne控制台创建 Pages / Makers项目，选择**直接上传**，不要选择 Git仓库导入。
2.构建后上传 `deploy-edgeone/`（只含 `index.html`和 `edge-functions/[[...default]].js`），或上传对应 ZIP。
3.构建命令留空。**不要直接上传项目根目录**，否则 README、源码和 ZIP可能被当成静态文件公开。
4. **不要创建或绑定 KV**。项目设置里即使出现 KV入口，也与本版本无关。
5. 在项目的环境变量中按需配置下方网盘凭证，然后重新部署。
6. 打开绑定的域名：`/`应显示 WALLPIC门面页，`/json/parser?url=...`应返回 JSON。

### 方式 B：登录后使用 CLI

先运行 `node build.mjs`，再上传干净目录：

```powershell
npx edgeone makers deploy .\deploy-edgeone -n <项目名>
```

如果逐文件上传遇到 `cos.accelerate.myqcloud.com`的DNS错误，可将 `deploy-edgeone/`压缩后把 ZIP作为第一个参数上传。匿名试部署可追加 `--anonymous`，之后需登录并执行 `edgeone makers claim`认领。

## 二、阿里云 ESA

1. ESA控制台进入 **函数和 Pages →创建函数**。
2. 新建函数，上传或粘贴 `functions/[[default]].js`，生成版本并发布。
3. **不要创建 EdgeKV存储空间**。
4. 通过域名或路由把请求转发到该函数。
5. 如修改了函数变量，需要重新生成版本并发布，变量快照才会生效。

如果控制台支持上传 ZIP，直接使用 `jxpan-edgeone-parse-only.zip`即可；不需要把项目放入 Git仓库。

`esa.jsonc`保留用于支持目录上传的平台工具，其中入口为 `./functions/[[default]].js`，安装和构建命令均为空。

## 三、可选环境变量

环境变量只提供网盘登录态，不是 KV，也不是数据库。按实际使用的网盘配置即可，不需要全填：

| 变量 | 网盘 |
| --- | --- |
| `ALIYUN_AUTHORIZATION` | 阿里云盘 |
| `QK_COOKIE` | 夸克 |
| `UC_COOKIE` | UC |
| `MCLOUD_AUTHORIZATION` / `MCLOUD_COOKIE` | 移动云盘 |
| `CLOUD189_TOKEN`（兼容 `P189_TOKEN`） | 天翼云盘 |
| `PAN123_AUTHORIZATION` | 123云盘 |
| `GY_Login` | 光鸭 |
| `FEIJI_USER` / `FEIJI_PASS` | 小飞机 |
| `ILANZOU_USER` / `ILANZOU_PASS` | 蓝奏云优享版 |

还有各组件的 `*_ENABLED`、`*_USER_AGENT`，以及公告相关变量（`ANNOUNCEMENT_*`）可选。无需设置 `admin`、`pass`，它们在本版本没有用途。

>凭证会随网盘策略失效。本版本没有扫码登录和后台保存入口，失效后请更新平台环境变量并重新部署。

## 四、接口

JSON：

```text
GET https://你的域名/json/parser?url=<URL编码后的分享链接>
```

等价写法：

```text
GET https://你的域名/?url=<URL编码后的分享链接>&type=json
```

直接下载（支持时返回302）：

```text
GET https://你的域名/?url=<URL编码后的分享链接>&type=down
```

可选参数：`pwd`分享密码、`fid`文件夹、`id`文件 ID。子文件夹通常使用 `fid`或 `fid2`、`fid3`等参数；具体参数支持取决于网盘解析流程。

成功响应中的实际下载地址通常在 `data.download_url`；文件列表在 `data.list`。解析失败时请查看 HTTP状态、JSON的 `code` / `msg`，以及平台函数日志。

## 五、行为与限制

- `/admin`、`/admin/*`、`/api/create-short`、`/s/*`固定返回 `404`。
- 登录、扫码、记录、统计、短链相关 `action`固定返回 `404`，查询参数和 POST表单都会被检查。
- 上游解析抛异常时，入口会返回 JSON `500`，不会把运行时异常直接暴露为 HTML崩溃页。
- ESA单次执行的外部 `fetch`子请求数量有限；多级目录遍历可能受平台限制。
- 部分网盘解析需要有效登录态，或者对同一账号、IP、频率较敏感。
- 该版本不做解析缓存，因此每次请求都会实时访问网盘；这是不使用存储的代价。

## 六、本地验证

```powershell
cd E:\web_APP\openlist_wallpic\jxpan-edgeone-parse-only
node test/parse-only.test.mjs
```

构建物更新：

```powershell
node build.mjs
```

## 七、说明

沿用上游 MIT协议。仅供个人学习与技术交流，高频请求可能触发网盘风控，账号风险自担。
