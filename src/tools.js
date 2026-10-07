/**
 * 工具定义：每个注册表里 implemented 的托管工具变成一个 DSH defineTool 注册项。
 *
 * 与 pi 版的对应关系：pi 的 IMPLEMENTATIONS 键 → 这里 `makeTool(spec)` 里按 spec.id 分发；
 * pi 的 submitAsync → `runAsync`，完成时通过调用这次工具的 agent 的 followup 注入消息
 * （pi 版是全局 deliverer，DSH 版在每次 execute 里捕获 `exec.agent`，见 index.js 说明）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { codexImage, codexWebSearch, xaiGenerateImage, xaiHostedRun, XAI_DEFAULT_MODEL } from "./http.js";
import { cancelJob, finishJob, formatElapsed, renderJobs, startJob } from "./jobs.js";
import { findTool } from "./registry.js";

/** 出图落盘目录（相对于会话工作目录）。 */
export const IMAGE_DIR = "images";

/** hosted_jobs 工具名：完成注入的消息里会让模型提它。 */
export const JOBS_TOOL = "hosted_jobs";

// --------------------------------------------------------------------- 公共

/** 消息来源 kind：一条新的 producer-owned kind，格式 v4 允许插件自定义。 */
const JOBS_SOURCE = { kind: "dsh-hosted-tools" };

function slugOf(value) {
  return value.replace(/[^a-zA-Z0-9一-龥]+/g, "-").replace(/^-+/, "");
}

/** 会话工作目录：工具调用自己的 agent 拿（exec.agent.session.header.cwd），没有就用进程 cwd。 */
function sessionCwd(exec) {
  return exec.agent?.session.header.cwd ?? process.cwd();
}

async function saveImage(cwd, data, slug) {
  const dir = join(cwd, IMAGE_DIR);
  await mkdir(dir, { recursive: true });
  const extension = data.mimeType === "image/jpeg" ? "jpg" : (data.mimeType?.split("/")[1] ?? "png");
  const shortSlug = slugOf(slug).slice(0, 24).replace(/[-\s]+$/, "");
  const name = `${Date.now()}${shortSlug ? `-${shortSlug}` : ""}.${extension}`;
  const path = join(dir, name);
  const bytes = data.base64
    ? Buffer.from(data.base64, "base64")
    : Buffer.from(await (await fetch(data.url)).arrayBuffer());
  await writeFile(path, bytes);
  return path;
}

function sourceBlock(sources) {
  if (!sources?.length) return "";
  const lines = sources.slice(0, 10).map((source) => {
    const title = source.title ? `${source.title} — ` : "";
    const snippet = source.snippet ? `\n  ${source.snippet.slice(0, 200)}` : "";
    return `- ${title}${source.url}${snippet}`;
  });
  return `\n\n来源：\n${lines.join("\n")}`;
}

/** 一行参数摘要，用来认这是哪次调用：主参数取前 60 个字，其余只报键名。 */
function briefArgs(params) {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  const main = entries.find(([, value]) => typeof value === "string" && value.trim() !== "");
  const brief = main ? String(main[1]).replace(/\s+/g, " ").trim().slice(0, 60) : "（无参数）";
  const others = entries.filter(([key]) => key !== main?.[0]).map(([key]) => key);
  return others.length > 0 ? `${brief}（另带 ${others.join("、")}）` : brief;
}

function firstLine(body) {
  const line = body.split("\n").find((item) => item.trim() !== "") ?? "（空结果）";
  return line.trim().slice(0, 80);
}

// ------------------------------------------------------------------ 执行体

/**
 * 工具的同步执行：返回给模型的正文字符串。
 * @param {string} id 注册表 id
 * @param {Record<string, unknown>} params
 * @param {import("@deepseek-ai/dsh-tools").ToolRunContext} exec
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
async function runSync(id, params, exec, credentials, signal) {
  switch (id) {
    case "openai/web-search": {
      const query = String(params.query ?? "").trim();
      if (!query) throw new Error("query 不能为空");
      const answer = await codexWebSearch(credentials, { query, signal });
      return `${answer.answer}${sourceBlock(answer.sources)}`;
    }
    case "openai/image-generation": {
      const prompt = String(params.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const images = Array.isArray(params.images) ? params.images.filter(Boolean) : undefined;
      const image = await codexImage(credentials, {
        prompt,
        ...(params.model ? { model: String(params.model) } : {}),
        ...(images?.length ? { images } : {}),
        signal,
      });
      const path = await saveImage(sessionCwd(exec), image, prompt);
      const note = image.revisedPrompt ? `\n改写后的提示词：${image.revisedPrompt}` : "";
      return `图片已保存：${path}${note}`;
    }
    case "xai/web-search": {
      const query = String(params.query ?? "").trim();
      if (!query) throw new Error("query 不能为空");
      const { text } = await xaiHostedRun(
        credentials,
        ["web_search"],
        `用联网搜索回答下面这个问题，结论要准确、给出关键事实与出处。\n\n${query}`,
        signal,
      );
      return text;
    }
    case "xai/x-search": {
      const query = String(params.query ?? "").trim();
      if (!query) throw new Error("query 不能为空");
      const { text } = await xaiHostedRun(
        credentials,
        ["x_search"],
        `在 X 上检索并回答下面这个问题，引用具体帖子。\n\n${query}`,
        signal,
      );
      return text;
    }
    case "xai/code-execution": {
      const task = String(params.task ?? "").trim();
      if (!task) throw new Error("task 不能为空");
      const { text } = await xaiHostedRun(
        credentials,
        ["code_execution"],
        `用代码执行完成下面的任务，把最终结果和用到的关键代码一并给出。\n\n${task}`,
        signal,
      );
      return text;
    }
    case "xai/image-generation": {
      const prompt = String(params.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      const result = await xaiGenerateImage(credentials, {
        prompt,
        ...(params.model ? { model: String(params.model) } : {}),
        ...(params.n ? { n: Number(params.n) } : {}),
        signal,
      });
      const saved = [];
      for (const [index, url] of result.urls.entries()) {
        saved.push(await saveImage(sessionCwd(exec), { url }, `${prompt}-${index + 1}`));
      }
      for (const [index, base64] of (result.b64s ?? []).entries()) {
        saved.push(await saveImage(sessionCwd(exec), { base64 }, `${prompt}-${index + 1}`));
      }
      if (saved.length === 0) throw new Error("xAI 出图没有返回可保存的图片");
      return `图片已保存：\n${saved.map((path) => `- ${path}`).join("\n")}`;
    }
    case "xai/image-edit": {
      const prompt = String(params.prompt ?? "").trim();
      const image = String(params.image ?? "").trim();
      if (!prompt) throw new Error("prompt 不能为空");
      if (!image) throw new Error("image 不能为空（本地路径或 data URL）");
      const result = await xaiGenerateImage(credentials, {
        prompt,
        images: [image],
        ...(params.model ? { model: String(params.model) } : {}),
        signal,
      });
      const saved = [];
      for (const [index, url] of result.urls.entries()) {
        saved.push(await saveImage(sessionCwd(exec), { url }, `${prompt}-edit-${index + 1}`));
      }
      for (const [index, base64] of (result.b64s ?? []).entries()) {
        saved.push(await saveImage(sessionCwd(exec), { base64 }, `${prompt}-edit-${index + 1}`));
      }
      if (saved.length === 0) throw new Error("xAI 改图没有返回可保存的图片");
      return `图片已保存：\n${saved.map((path) => `- ${path}`).join("\n")}`;
    }
    default:
      throw new Error(`未注册的托管工具 ${id}`);
  }
}

// ------------------------------------------------------------------ 异步提交

/**
 * 异步提交：立刻返回 jobId，后台跑完后用这次调用的 agent 的 followup 把结果注入对话。
 * 没有 agent（非会话调用方）时退化为同步——让模型等到结果，而不是丢任务。
 */
async function runAsync(spec, params, exec, credentials, sessions) {
  const agent = exec.agent;
  if (!agent) {
    return runSync(spec.id, params, exec, credentials, exec.signal);
  }
  const argsBrief = briefArgs(params);
  const { jobId, controller } = startJob(
    { toolId: spec.id, tool: spec.tool, label: spec.label, argsBrief },
    (text) => {
      // 结果以一条独立消息进会话（下一轮处理）。source.kind 用插件自己的
      // producer kind，重启后也能从 session 归档里认出来是谁投的。
      agent.followup(createUserMessage({ content: [{ type: "text", text }], source: JOBS_SOURCE }));
      // 投完立刻落盘：进程在投递与驱动器消费之间退出时，归档里仍有这条消息。
      sessions?.flush(agent.session);
    },
  );
  const startedAt = Date.now();
  const input = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
  runSync(spec.id, input, exec, credentials, controller.signal).then(
    (body) => {
      const elapsed = formatElapsed(startedAt);
      finishJob(
        jobId,
        "done",
        firstLine(body),
        `【后台任务完成】${spec.tool} · ${elapsed} · ${jobId}\n调用参数：${argsBrief}\n\n${body}`,
      );
    },
    (error) => {
      const elapsed = formatElapsed(startedAt);
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = controller.signal.aborted;
      finishJob(
        jobId,
        "failed",
        cancelled ? "已取消" : message,
        cancelled
          ? `【后台任务已取消】${spec.tool} · ${elapsed} · ${jobId}\n调用参数：${argsBrief}\n（由 ${JOBS_TOOL} 取消）`
          : `【后台任务失败】${spec.tool} · ${elapsed} · ${jobId}\n调用参数：${argsBrief}\n错误：${message}`,
      );
    },
  );
  return `已提交后台执行（任务 ${jobId}）。结果出来后会作为一条消息自动出现在对话里，期间可以继续做别的事；要看进度用 ${JOBS_TOOL}。`;
}

// ------------------------------------------------------------------ 参数 schema

/**
 * 每个工具的参数表（dsh-tools ParameterSchemaSpec DSL：属性表本身就是隐式
 * 开放对象根，必填用属性上的 `required: true` 标记）。能给模型的字段就这些，
 * 其余（端点、鉴权、落盘）插件自己定。
 */
const PARAMETERS = {
  "openai/web-search": {
    query: { type: "string", description: "搜索问题", required: true },
  },
  "openai/image-generation": {
    prompt: { type: "string", description: "图像提示词", required: true },
    model: { type: "string", description: "模型名（默认 gpt-image-2.5）" },
    images: {
      type: "array",
      items: { type: "string" },
      description: "参考图 URL（可选，给了就按改图处理）",
    },
  },
  "xai/web-search": {
    query: { type: "string", description: "搜索问题", required: true },
  },
  "xai/x-search": {
    query: { type: "string", description: "X 平台的检索问题", required: true },
  },
  "xai/code-execution": {
    task: { type: "string", description: "需要执行代码完成的任务", required: true },
  },
  "xai/image-generation": {
    prompt: { type: "string", description: "图像提示词", required: true },
    model: { type: "string", description: "模型名（可选）" },
    n: { type: "number", description: "张数（可选）" },
  },
  "xai/image-edit": {
    prompt: { type: "string", description: "编辑要求", required: true },
    image: { type: "string", description: "参考图：本地路径或 data URL", required: true },
    model: { type: "string", description: "模型名（可选）" },
  },
};

// ------------------------------------------------------------------ 注册

/**
 * 给一个注册表 spec 建 ToolDefinition。
 * @param {import("./registry.js").HostedToolSpec} spec
 * @param {object} options
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} options.credentials `ctx.credentials`
 * @param {import("@deepseek-ai/dsh-session").SessionStore | undefined} options.sessions `ctx.sessions`（可空）
 * @param {"sync"|"async"} options.mode
 */
export function makeTool(spec, { credentials, sessions, mode }) {
  const asyncMode = mode === "async";
  return defineTool({
    name: spec.tool,
    description: `${spec.label}（provider 托管能力，由插件直接调用 ${spec.provider} 接口）。${spec.description}`,
    parameters: PARAMETERS[spec.id] ?? {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    timeoutMs: asyncMode ? 30_000 : 300_000,
    async execute(params, exec) {
      return asyncMode
        ? runAsync(spec, params, exec, credentials, sessions)
        : runSync(spec.id, params, exec, credentials, exec.signal);
    },
  });
}

/** hosted_jobs：列后台任务 / 按 id 取消。 */
export function makeJobsTool() {
  return defineTool({
    name: JOBS_TOOL,
    description: "查看或取消托管工具的后台任务。action=list 列任务；action=cancel 加 ref（jobId 或其前缀）取消。",
    parameters: {
      action: {
        type: "string",
        enum: ["list", "cancel"],
        description: "list 列任务；cancel 取消",
        required: true,
      },
      ref: { type: "string", description: "cancel 时的 jobId 或前缀" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute(params) {
      if (params.action === "cancel") {
        const ref = String(params.ref ?? "").trim();
        if (!ref) throw new Error("cancel 需要 ref（jobId 或前缀）");
        const result = cancelJob(ref);
        if (!result.ok) throw new Error(result.error);
        return `已取消任务 ${ref}。`;
      }
      return renderJobs();
    },
  });
}

export { findTool };
