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

- **Base URL**：例如 `https://192.3.64.212:28317`（`https://`，端口，**不要**加 `/quota`，插件自己会拼）
- **Token**：服务端的 `X-Quota-Token`

Google 会返回**两组**额度，而两组的窗口名字是一样的（都有「周」和「5 小时」），所以面板里会给每组加一个标题：

```
Antigravity                            ↻
Gemini Models
  周                          剩余 99%
  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
  2h 14m 后重置
  5 小时                      剩余 100%
  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
  2h 14m 后重置
Claude and GPT models
  周                        剩余 98.5%
  ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
  2h 14m 后重置
```

没有这个标题就会显示成两根光秃秃的「周」和两根「5 小时」，看不出哪个属于哪个。

### 显示约定

这几个约定参考了同类产品（[CodexBar](https://codexbar.app) 这类额度菜单栏工具、GitHub Copilot 配额扩展、Anthropic / Cursor 的用量页）：

- **每个来源带品牌图标**：迷你态和展开态都会显示该产品自己的图标（WorkBuddy 的绿色机器人、Google Antigravity 的彩虹弧线）。
- **数值带方向词**：「剩余 78%」，不是光秃秃的「78%」——否则读者要自己判断进度条是涨还是跌。
- **一个指标只给一个数**：进度条本身已表达比例，所以有了百分比就不再重复「1,567 / 2,000」。只有 WorkBuddy 积分这种**有绝对值的余额**才显示 `1,567.9 / 2,000`，因为那个数比它的百分比更有用。
- **重置时间用倒计时**：「2h 14m 后重置」比「11/03 00:00」更直观——不用自己减。超过一周才退回日期（那种情况日期更好排计划）。
- **阈值配色**：剩余 ≤30% 转琥珀、≤10% 转红并加「不足」小标签。颜色**永远只是第二重编码**，数字始终显示，状态不靠颜色单独承载。
- **用尽时换内容**：剩余 0% 时百分比是最没用的信息，改显示重置倒计时。
- **未知不等于 0**：取不到数据显示「—」，绝不显示 0%，也不会被染成红色。

### 图标从哪来

两个图标都不是我画的，而是取自产品**自己的安装包**，所以是真实品牌标识：

| 来源 | 取处 |
|---|---|
| WorkBuddy | `D:\Program\WorkBuddy\Assets\Square44x44Logo.targetsize-256.png` |
| Google Antigravity | 官方 installer.exe 内嵌的 256×256 logo |

它们由 [`scripts/build-icons.py`](scripts/build-icons.py) 压成 32px PNG 并**以 data URI 内联进 `lib/client.js`**（合计约 4.3 KB）。之所以内联而不是放独立模块：浏览器半边的 `require` **只支持 `react` 和 `react/jsx-runtime`**，独立文件根本 import 不了。

重新生成：

```bash
python scripts/build-icons.py
```

脚本是幂等的（在 `//#region generated: brand icons` 标记之间重写），可安全重复运行。

---

## 安全说明

- 所有 HTTP 路由**只服务本机**：要求 `Host` 头是回环地址，浏览器发来的 `Origin` 也必须是回环，并额外核对套接字地址。之所以不只靠 `Host`，是因为**回环绑定本身不是信任边界**——任何本地进程，或一个用 DNS rebinding 把自己域名指向 `127.0.0.1` 的网页，都能连上本机端口。测试里有专门的 DNS-rebinding 用例来钉住这条。
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
