/**
 * 凭据读取：统一从 DSH 的 `llm-pi-ai` 凭据域取 OAuth grant。
 *
 * dsh-llm-pi-ai 存凭据的格式（lib/index.js `toRecord`/`toPiCredential`）：
 *   key     = credentialKey("llm-pi-ai", providerId)，如 "llm-pi-ai/xai"、"llm-pi-ai/openai-codex"
 *   record  = { kind: "grant", payload: <pi-ai OAuthCredential 原样> }
 *   payload = { type: "oauth", refresh, access, expires, ...额外字段如 accountId }
 *
 * 这里只读 `payload.access`（accountId 从 JWT 里解）。令牌过期/刷新由 dsh-llm-pi-ai
 * 自己的授权流程负责（它注册了 authorization flow）；本插件不做 OAuth refresh——
 * 真过期时报错并把「重新登录」写进错误提示。
 */

import { credentialKey } from "@deepseek-ai/dsh-credentials";

const CREDENTIAL_SCOPE = "llm-pi-ai";

/**
 * 取一个 provider 的 OAuth access token。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials `ctx.credentials`
 * @param {string} providerId pi-ai provider id，如 "xai"、"openai-codex"
 * @returns {Promise<{accessToken: string, payload: Record<string, unknown>}>}
 */
export async function oauthCredential(credentials, providerId) {
  const record = await credentials.readRecord(credentialKey(CREDENTIAL_SCOPE, providerId));
  if (!record) {
    throw new Error(`没有 ${providerId} 凭据。先在 DSH 的模型设置里登录 ${providerId}。`);
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error(`${providerId} 凭据格式不对（缺 payload）。重新登录 ${providerId}。`);
  }
  const accessToken = stringOf(payload.access) ?? stringOf(payload.access_token) ?? stringOf(payload.token);
  if (!accessToken) {
    throw new Error(`${providerId} 凭据里没有 access token。重新登录 ${providerId}。`);
  }
  return { accessToken, payload };
}

/**
 * 看一个 provider 现在有没有可用凭据。只读，不触发登录，供设置页显示状态用。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @param {string} providerId pi-ai provider id，如 "xai"、"openai-codex"
 * @returns {Promise<{authorized: boolean, expired: boolean, expires?: number}>}
 */
export async function credentialStatus(credentials, providerId) {
  const record = await credentials.readRecord(credentialKey(CREDENTIAL_SCOPE, providerId));
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") return { authorized: false, expired: false };
  const accessToken = stringOf(payload.access) ?? stringOf(payload.access_token) ?? stringOf(payload.token);
  if (!accessToken) return { authorized: false, expired: false };
  const expires = numberish(payload.expires) ?? numberish(payload.expires_at);
  if (expires === undefined) return { authorized: true, expired: false };
  return { authorized: true, expired: expires <= Date.now(), expires };
}

/**
 * ChatGPT 凭据 = access token + account id。account id 优先取 payload.accountId，
 * 没有就从 access token 的 JWT 载荷里解（claim `https://api.openai.com/auth`.chatgpt_account_id）。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @returns {Promise<{accessToken: string, accountId: string}>}
 */
export async function codexCredentials(credentials) {
  const { accessToken, payload } = await oauthCredential(credentials, "openai-codex");
  const accountId =
    stringOf(payload.accountId) ?? stringOf(payload.account_id) ?? accountIdFromJwt(accessToken);
  if (!accountId) {
    throw new Error("ChatGPT 凭据里没有 account id，无法调用 codex 后端。重新登录 openai-codex。");
  }
  return { accessToken, accountId };
}

export function accountIdFromJwt(token) {
  if (!token) return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    if (typeof claims !== "object" || claims === null) return undefined;
    const auth = claims["https://api.openai.com/auth"];
    if (typeof auth !== "object" || auth === null) return undefined;
    return stringOf(auth.chatgpt_account_id);
  } catch {
    return undefined;
  }
}

function stringOf(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberish(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
