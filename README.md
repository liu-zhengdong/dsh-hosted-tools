# dsh-hosted-tools

pi-hosted-tools 的 DSH 移植：把 provider 托管能力（网页搜索、X 搜索、代码执行、出图/改图）作为一组 DSH 工具注册进来。

## 工具

| 工具 | 后端 | 默认暴露方式 |
| --- | --- | --- |
| `openai_web_search` | ChatGPT 账号 `/backend-api/codex/alpha/search` | 同步 |
| `openai_image` | ChatGPT 账号 `/backend-api/codex/images` | 后台异步 |
| `xai_web_search` | `api.x.ai/v1/responses` + `web_search` | 后台异步 |
| `xai_x_search` | `api.x.ai/v1/responses` + `x_search` | 后台异步 |
| `xai_code_execution` | `api.x.ai/v1/responses` + `code_execution` | 后台异步 |
| `xai_image_generate` | `api.x.ai/v1/images/generations` | 同步 |
| `xai_image_edit` | `api.x.ai/v1/images/edits` | 同步 |
| `hosted_jobs` | 本插件任务台账 | 只要还有工具暴露就自动提供 |

异步工具立刻回执一个 jobId，结果完成后以一条消息注入当前会话；用 `hosted_jobs`（`action=list` / `action=cancel` + `ref`）查看或取消。异步判据是实测耗时（pi 版 README 的「验证」）：十几秒以上的一律默认异步。

## 暴露给 DSH 的工具

「设置 → 内置插件 → 托管工具」里每个工具一行三态：**不暴露**（不注册，模型看不见）、**同步**（注册，调用等结果）、**后台异步**（注册，立刻回执）。

- 配置就是插件 Config：每个工具一个字段，字段名 = 工具名，取值 `off` / `sync` / `async`。默认值写在 `src/index.js` 的 schema 里，界面文案（名称、说明、计费风险）也来自同一处——客户端不另存一份工具表。
- 字段声明为 `volatile`：保存时 cordis 只把新值写进运行中的引用并广播 `loader/volatile-update`，插件不重挂；宿主据此增删工具注册，不会打断在途的工具调用。
- 改动由 `configEditor` 写进当前 profile 的 `cordis.patch.yml`。选回默认值的那一档走 `unset`：这条覆盖会被删掉（只剩 id/name 时整行删掉），所以 profile 里只留与默认不同的部分。

## 凭据

读 `llm-pi-ai` 凭据域（`credentialKey("llm-pi-ai", providerId)`），与 `dsh-llm-pi-ai` 登录写入的是同一份。xAI 工具用 `xai` provider，codex 工具用 `openai-codex` provider。令牌过期时报错提示重新登录；插件不刷新令牌。

## 登录

「设置 → 内置插件 → 托管工具」上半段是 xAI 与 OpenAI Codex 两行，点「登录」直接在插件设置里跑 OAuth：xAI 是设备码（显示验证码与链接），Codex 先选浏览器登录或设备码，浏览器登录需要把回调地址里的授权码粘回来。取消按钮中止当前尝试。

client 半只注册这个页签，真正干活的是宿主侧 `src/auth-remote.js`：它把 `ctx.authorization` 里 `dsh-llm-pi-ai` 注册的登录流（key 形如 `llm-pi-ai/xai`）桥接成 Remote 命名空间 `hostedToolsAuth`（`flows` / `begin` / `respond` / `cancel`）。这样登录不依赖 pi-ai 之外的任何东西，也不需要用户去配置 provider。

## 与 pi 版的差别

- pi 版的 xAI 托管搜索走 pi 的 `samplingParams` 让 pi-ai 在采样时加 `tools`；DSH 没有这条透传通道，改为插件直接 POST Responses API——模型与工具执行仍在 xAI 侧，只是请求发起者是插件。
- pi 版开关存在 `~/.pi/agent/hosted-tools.json` 且带 UI；DSH 版就是插件 Config，UI 在插件设置页里（见上）。
- pi 版异步结果回写终端；DSH 版通过 `agent.followup` 注入当前会话（来源 kind `dsh-hosted-tools`），并 `sessions.flush` 落盘。
- 界面直接用宿主设计系统的 `@deepseek-ai/dsh-client-ui-primitives`（Button / Tag / SegmentedControl）与 `--dsw-*` 设计令牌，随宿主明暗主题；不手搓按钮、分段控件与色板。
