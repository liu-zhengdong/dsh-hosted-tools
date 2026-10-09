/**
 * dsh-hosted-tools —— 把 pi-hosted-tools 的 provider 托管能力搬进 DSH。
 *
 * 提供一组可直接调用的工具：ChatGPT 网页搜索/出图（codex 后端）、xAI 网页搜索/
 * X 搜索/代码执行（Responses API 的服务端工具）、Grok Imagine 出图/改图，以及
 * 后台任务管理工具 hosted_jobs。
 *
 * 与 pi 版的差别：
 * - DSH 的 LLM 层没有 `samplingParams` 透传，xAI 的"托管工具"改为插件直接 POST
 *   `api.x.ai/v1/responses`（模型与工具执行仍在 xAI 侧，只是请求发起者是插件）。
 * - pi 版把开关存在 `~/.pi/agent/hosted-tools.json`；DSH 版存在插件 Config 里，
 *   每个工具一个三态字段（off/sync/async），在「设置 → 内置插件 → 托管工具」里改。
 * - pi 版异步完成靠全局 deliverer 回写终端；DSH 版在每次 execute 里捕获
 *   `exec.agent`，完成时用 `agent.followup` 把结果作为一条消息注入该会话。
 *
 * 凭据：统一读 `llm-pi-ai` 凭据域（dsh-llm-pi-ai 登录时写入），key 是
 * `credentialKey("llm-pi-ai", providerId)`；令牌过期前 5 分钟自动刷新并写回，
 * 刷新失败（refresh token 被吊销）才报错提示重新登录，见 credentials.js。
 */

import z from "@deepseek-ai/schemastery";
import { installAuthRemote } from "./auth-remote.js";
import { EXPOSURE_MODES, RISK_LABELS, defaultExposure, implementedTools } from "./registry.js";
import { makeJobsTool, makeTool } from "./tools.js";

export const name = "dsh-hosted-tools";

export const inject = ["tools", "credentials", "sessions", "authorization"];

/**
 * 配置：每个已实现的工具一个字段，字段名就是注册给 DSH 的工具名，取值 off/sync/async
 * （见 registry.js 的 EXPOSURE_MODES）。字段必须声明 volatile：这样改配置时 cordis 只把
 * 新值写进这些引用、广播 `loader/volatile-update`，插件本身不重挂——否则保存配置会把在途的
 * 工具调用连同它的 Remote 响应一起销毁。volatile 只能落在固定对象路径上，所以这里不能
 * 用 z.dict/z.array 表达"每个工具的开关"。默认值来自注册表（异步判据是实测耗时）。
 */
export const Config = z.object(
  Object.fromEntries(
    implementedTools().map((spec) => [
      spec.tool,
      z
        .union(EXPOSURE_MODES)
        .default(defaultExposure(spec.id))
        .volatile()
        .comment(spec.label)
        .description(`${spec.description}（计费风险：${RISK_LABELS[spec.risk]}）`),
    ]),
  ),
);

function log(text) {
  process.stderr.write(`dsh-hosted-tools: ${text}\n`);
}

/**
 * @param {import("@deepseek-ai/dsh-tools").ToolRuntime} ctx.tools 由 inject 装配进 ctx
 */
export function apply(ctx, config) {
  /** 已注册的工具：工具名 → { spec, mode, dispose }。 */
  const registered = new Map();
  /** hosted_jobs 的 disposer；它随"是否还有工具暴露"一起增删。 */
  let jobsDispose;

  /**
   * 把注册状态对齐到当前配置。工具名撞车或 mode 变化时先卸后装，hosted_jobs 只在还有
   * 工具暴露时挂着——后台任务可能在工具切回同步之后仍需要查看，所以它不随 async 单独增删。
   */
  function sync() {
    const wanted = new Map();
    for (const spec of implementedTools()) {
      const mode = config[spec.tool].get();
      if (mode !== "off") wanted.set(spec.tool, { spec, mode });
    }

    for (const [tool, entry] of [...registered]) {
      const want = wanted.get(tool);
      if (want === undefined) {
        entry.dispose();
        registered.delete(tool);
        log(`已移除 ${tool}（不再暴露）`);
      } else if (want.mode !== entry.mode) {
        entry.dispose();
        registered.delete(tool);
        log(`已卸载 ${tool}（${entry.mode} → ${want.mode}）`);
      }
    }
    for (const [tool, want] of wanted) {
      if (registered.has(tool)) continue;
      const dispose = ctx.tools.register(
        makeTool(want.spec, { credentials: ctx.credentials, sessions: ctx.sessions, mode: want.mode }),
      );
      registered.set(tool, { spec: want.spec, mode: want.mode, dispose });
      log(`已注册 ${tool}（${want.spec.id}，${want.mode}）`);
    }

    if (registered.size > 0 && jobsDispose === undefined) {
      jobsDispose = ctx.tools.register(makeJobsTool());
      log("已注册 hosted_jobs");
    } else if (registered.size === 0 && jobsDispose !== undefined) {
      jobsDispose();
      jobsDispose = undefined;
      log("已移除 hosted_jobs：没有工具暴露");
    }
  }

  sync();
  // 配置界面保存的就是这些 volatile 字段：cordis 把新值写进引用后通知本插件，我们按新值增删工具。
  ctx.on("loader/volatile-update", sync);

  // OAuth 登录 Remote 命名空间：设置页模型卡片上的「登录」按钮从这里调
  // ctx.authorization 里由 dsh-llm-pi-ai 注册的登录流（key = "llm-pi-ai/<id>"）。
  installAuthRemote(ctx);

  log(`完成：${registered.size} 个工具启用`);
}
