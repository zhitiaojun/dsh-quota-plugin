# DSH Quota

> 在一个常驻读数里汇总多个 AI 订阅的剩余额度。独立实现，不依赖其它 DSH 插件。
>
> Aggregate the remaining quota of several AI subscriptions into one always-visible read-out. Standalone — depends on no other plugin.

---

## 这是什么

`dsh-quota-plugin` 在 DeepSeek Harness 的**输入框下方常驻显示**一行额度摘要，点击展开详情面板，里面有进度条和逐项明细：

```
Gemini 周98% 5h99% · Claude 周99% 5h100% · WorkBuddy 主号 1568
```

支持两类数据源，每类可以配多个，**每个来源都能自定义名称**：

| 类型 | 数据 | 凭证 |
|---|---|---|
| `workbuddy` | WorkBuddy / CodeBuddy 剩余积分（含总额与重置时间） | `ck_...` API Key |
| `google` | Google Antigravity 的 5 小时 / 周额度窗口 | 自建 HTTPS 端点的 URL + Token |

刷新**只在你手动点击时发生**，没有后台轮询。

---

## 为什么独立实现

本插件**不使用** `dsh-workbuddy-connect`，也不 import 它的任何代码。这样即使那个插件被卸载、升级或损坏，本插件照常工作。

WorkBuddy 的读取逻辑是独立复刻的：用 `X-API-Key` 调 `/v2/accounts` 拿到账号身份，再调计费端点取积分。

---

## 安装

```bash
# 从 GitHub 源码安装
dsh plugin --profile desktop add github:zhitiaojun/dsh-quota-plugin
dsh --profile desktop
```

安装后：

1. 打开 **设置 → 插件 → DSH Quota**
2. 添加数据源（见下）
3. 输入框下方会出现额度读数

---

## 配置数据源

配置存在 `$DSH_HOME/.dsh-quota-sources.json`（权限 600）。也可以直接在设置页里改。

### WorkBuddy / CodeBuddy

只需要一个 API Key：

1. 打开 <https://www.workbuddy.cn/profile/keys>
2. 创建一个 API Key（`ck_...`）
3. 填进设置页的 **API Key** 字段

账号身份（uid、企业 ID）由插件自己调 `/v2/accounts` 解析，**不需要你手填**。

> **多个订阅**：每个账号建一个来源即可，各自起名区分（例如「WorkBuddy 主号」「WorkBuddy 备用」）。

### Google Antigravity

需要一个自建的小 HTTPS 端点，它在本机跑 `agy -p "/usage" --output-format json` 并把结果转成 JSON。参见 [`quota-api/`](quota-api/) —— 里面是完整的服务端实现和 systemd 单元。

设置页填两项：

- **Base URL**：例如 `https://192.3.64.212:28317`
- **Token**：服务端的 `X-Quota-Token`

---

## 安全说明

- 所有 HTTP 路由**只接受本机回环**请求（`127.0.0.1` / `::1`），拒绝其它来源。
- 填进设置页的 Token 与 API Key **以明文存于本机** `$DSH_HOME/.dsh-quota-sources.json`（权限 600）。DSH 插件配置没有可用的加密存储，自动读取需要明文可读。**不要把这个文件提交到版本库或分享出去。**
- 来源列表文件可被手工编辑；插件每次调用都重新读取，不需要重启。

---

## 开发

```bash
npm test          # 跑 host 与 client 两半的测试
npm run check     # host 半边的语法检查
```

测试全部离线：`fetch` 被替换为桩，`DSH_HOME` 指向临时目录。**不需要任何真实凭证。**

### 结构

```
lib/index.js     host 半边（Node）：上游调用、来源持久化、HTTP 路由
lib/client.js    浏览器半边：composer.dock 常驻读数、详情面板、设置页
test/            两半的测试
quota-api/       Google 侧的服务端（Python，可选依赖）
```

---

## 限制

- WorkBuddy 的接口是**非官方**的客户端接口，上游改动可能使其失效。
- Google 侧依赖 `agy` CLI 已登录；它每次调用约 4–8 秒（进程启动开销）。
- 未实现自动刷新（按设计）。

---

## License

MIT
