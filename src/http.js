/**
 * HTTP 调用层：xAI Responses API（托管工具）、xAI images 端点、ChatGPT codex 后端。
 *
 * xAI 的 hosted 工具（web_search / x_search / code_execution）：pi 版靠 model adapter
 * 的 samplingParams 把 tools 塞进推理请求；DSH 没有这条路，所以插件直接向
 * `api.x.ai/v1/responses` POST——模型与工具执行仍在 xAI 侧，只是发起者是插件。
 */

import { oauthCredential, codexCredentials } from "./credentials.js";

export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_RESPONSES_URL = `${XAI_API_BASE_URL}/responses`;
export const XAI_IMAGES_GENERATIONS_URL = `${XAI_API_BASE_URL}/images/generations`;
export const XAI_IMAGES_EDITS_URL = `${XAI_API_BASE_URL}/images/edits`;
export const XAI_DEFAULT_MODEL = "grok-4.6";

export const CODEX_IMAGES_BASE_URL = "https://chatgpt.com/backend-api/codex/images";
export const CODEX_SEARCH_URL = "https://chatgpt.com/backend-api/codex/alpha/search";
export const CODEX_DEFAULT_IMAGE_MODEL = "gpt-image-2.5";
export const CODEX_DEFAULT_WEBSEARCH_MODEL = "gpt-5.6-luna";

// --------------------------------------------------------------------- 通用

async function postJson(url, headers, body, signal, label) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label}失败（HTTP ${response.status}）：${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------- xAI 托管

/**
 * 让 xAI 的服务端工具跑一次：POST /v1/responses，tools 里放服务端工具类型，
 * input 是给模型的指令。返回聚合后的文本。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @param {string[]} toolTypes 如 ["web_search"]
 * @param {string} input
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{text: string, model: string}>}
 */
export async function xaiHostedRun(credentials, toolTypes, input, signal) {
  const { accessToken } = await oauthCredential(credentials, "xai", signal);
  const payload = await postJson(
    XAI_RESPONSES_URL,
    { authorization: `Bearer ${accessToken}` },
    {
      model: XAI_DEFAULT_MODEL,
      input,
      tools: toolTypes.map((type) => ({ type })),
    },
    signal,
    "xAI 托管工具",
  );
  const text = responseText(payload);
  if (!text) throw new Error("xAI 托管工具没有返回文本结果");
  return { text, model: XAI_DEFAULT_MODEL };
}

/** Responses API 的文本：优先 output_text；没有就从 output 数组里的 message.content 里找 text。 */
function responseText(payload) {
  if (typeof payload !== "object" || payload === null) return "";
  const direct = payload.output_text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const output = payload.output;
  if (!Array.isArray(output)) return "";
  const parts = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue;
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (typeof block === "object" && block !== null && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n").trim();
}

// ------------------------------------------------------------------- xAI 图像

/**
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @param {{prompt: string, model?: string, images?: string[], n?: number, signal?: AbortSignal}} request
 * @returns {Promise<{urls: string[], b64s: string[]}>}
 */
export async function xaiGenerateImage(credentials, request) {
  return request.images?.length
    ? xaiEditImage(credentials, request)
    : xaiCreateImage(credentials, request);
}

async function xaiCreateImage(credentials, request) {
  const { accessToken } = await oauthCredential(credentials, "xai", request.signal);
  const body = { prompt: request.prompt, response_format: "url" };
  if (request.model) body.model = request.model;
  if (request.n) body.n = request.n;
  const payload = await postJson(
    XAI_IMAGES_GENERATIONS_URL,
    { authorization: `Bearer ${accessToken}` },
    body,
    request.signal,
    "xAI 出图",
  );
  return collectImages(payload);
}

/**
 * 改图：官方要求 JSON（`Content-Type: application/json`），参考图放在 `images` 数组里，
 * 每项 `{ type: "image_url", url }`；传 multipart/form-data 会被回 415。
 */
async function xaiEditImage(credentials, request) {
  const { accessToken } = await oauthCredential(credentials, "xai", request.signal);
  const images = [];
  for (const reference of request.images) {
    images.push({ type: "image_url", url: await toDataUrl(reference) });
  }
  const body = { prompt: request.prompt, images, response_format: "url" };
  if (request.model) body.model = request.model;
  const payload = await postJson(
    XAI_IMAGES_EDITS_URL,
    { authorization: `Bearer ${accessToken}` },
    body,
    request.signal,
    "xAI 改图",
  );
  return collectImages(payload);
}

function collectImages(payload) {
  const data = payload?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`xAI 图像接口没有返回 data：${JSON.stringify(payload).slice(0, 300)}`);
  }
  const urls = [];
  const b64s = [];
  for (const entry of data) {
    if (typeof entry?.url === "string") urls.push(entry.url);
    if (typeof entry?.b64_json === "string") b64s.push(entry.b64_json);
  }
  return { urls, b64s };
}

const MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** 把本地路径转成 data URL；已经是 data URL 或 http(s) 地址的原样返回。 */
async function toDataUrl(reference) {
  if (reference.startsWith("data:") || /^https?:\/\//.test(reference)) return reference;
  const extension = reference.toLowerCase().split(".").pop() ?? "";
  const mime = MIME_BY_EXTENSION[extension] ?? "image/png";
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(reference);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

// -------------------------------------------------------------- ChatGPT codex

/**
 * ChatGPT 网页搜索（codex 后端 `codex/alpha/search`）。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @param {{query: string, model?: string, signal?: AbortSignal}} request
 * @returns {Promise<{answer: string, sources: Array<{url: string, title?: string, snippet?: string}>}>}
 */
export async function codexWebSearch(credentials, request) {
  const creds = await codexCredentials(credentials, request.signal);
  const payload = await postCodex(
    CODEX_SEARCH_URL,
    creds,
    {
      id: crypto.randomUUID(),
      model: request.model ?? CODEX_DEFAULT_WEBSEARCH_MODEL,
      reasoning: { effort: "max" },
      input: request.query,
      commands: {
        search_query: [{ q: request.query }],
        response_length: "medium",
      },
      settings: { allowed_callers: ["direct"], external_web_access: true },
      max_output_tokens: 4096,
    },
    request.signal,
    "ChatGPT 搜索",
  );
  const answer = stringOf(payload.output);
  if (!answer) throw new Error("ChatGPT 搜索没有返回 output 字段");
  const results = Array.isArray(payload.results) ? payload.results : [];
  const sources = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.type !== "text_result") continue;
    const url = stringOf(entry.url);
    if (!url || !/^https?:\/\//.test(url)) continue;
    sources.push({
      url,
      ...(stringOf(entry.title) ? { title: stringOf(entry.title) } : {}),
      ...(stringOf(entry.snippet) ? { snippet: stringOf(entry.snippet) } : {}),
    });
  }
  return { answer, sources };
}

/**
 * ChatGPT 图像生成/编辑（codex 后端 `codex/images/generations|edits`）。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @param {{prompt: string, model?: string, images?: string[], signal?: AbortSignal}} request
 * @returns {Promise<{base64: string, mimeType: string, id?: string, revisedPrompt?: string}>}
 */
export async function codexImage(credentials, request) {
  const creds = await codexCredentials(credentials, request.signal);
  const editing = (request.images?.length ?? 0) > 0;
  const common = {
    prompt: request.prompt,
    background: "auto",
    model: request.model ?? CODEX_DEFAULT_IMAGE_MODEL,
    quality: "auto",
    size: "auto",
  };
  const body = editing
    ? { images: (request.images ?? []).map((image) => ({ image_url: image })), ...common }
    : common;
  const payload = await postCodex(
    editing ? `${CODEX_IMAGES_BASE_URL}/edits` : `${CODEX_IMAGES_BASE_URL}/generations`,
    creds,
    body,
    request.signal,
    editing ? "ChatGPT 改图" : "ChatGPT 出图",
  );
  const data = Array.isArray(payload.data) ? payload.data : [];
  const first = data.find(
    (entry) => typeof entry === "object" && entry !== null && stringOf(entry.b64_json),
  );
  if (!first) throw new Error("ChatGPT 图像接口没有返回 data[].b64_json");
  const { base64, mimeType } = splitDataUrl(stringOf(first.b64_json), payload.output_format);
  return {
    base64,
    mimeType,
    ...(stringOf(first.id) ? { id: stringOf(first.id) } : {}),
    ...(stringOf(first.revised_prompt) ? { revisedPrompt: stringOf(first.revised_prompt) } : {}),
  };
}

function codexHeaders(creds) {
  return {
    authorization: `Bearer ${creds.accessToken}`,
    "chatgpt-account-id": creds.accountId,
    accept: "application/json",
    "content-type": "application/json",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0 (dsh-hosted-tools)",
  };
}

async function postCodex(url, creds, body, signal, label) {
  const response = await fetch(url, {
    method: "POST",
    headers: codexHeaders(creds),
    body: JSON.stringify(body),
    signal,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  const text = await response.text();
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? "（凭据无效或过期，重新登录 openai-codex）" : "";
    throw new Error(`${label}失败（HTTP ${response.status}）${hint}：${text.slice(0, 300)}`);
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${label}返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

function splitDataUrl(value, outputFormat) {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match) return { mimeType: match[1] || "image/png", base64: (match[2] ?? "").trim() };
  const format = typeof outputFormat === "string" ? outputFormat : "png";
  const mimeType = format === "jpeg" || format === "jpg" ? "image/jpeg" : `image/${format}`;
  return { mimeType, base64: value.trim() };
}

function stringOf(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
