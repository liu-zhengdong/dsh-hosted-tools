/**
 * 凭据读取与刷新：统一走 DSH 的 `llm-pi-ai` 凭据域。
 *
 * dsh-llm-pi-ai 存凭据的格式（lib/index.js `toRecord`/`toPiCredential`）：
 *   key     = credentialKey("llm-pi-ai", providerId)，如 "llm-pi-ai/xai"、"llm-pi-ai/openai-codex"
 *   record  = { kind: "grant", payload: <pi-ai OAuthCredential 原样> }
 *   payload = { type: "oauth", refresh, access, expires, ...额外字段如 accountId }
 *
 * access token 过期前 5 分钟起，用 payload.refresh 去 provider 的 OAuth 端点换新令牌，
 * 经 `credentials.modifyRecord(key, mutate)` 写回——它是凭据缝的唯一写路径，持文件锁、
 * 锁内先与磁盘对账，且明确允许网络往返（pi-ai 自己的刷新也走这条路）。mutate 返回
 * undefined 表示保持原值，天然覆盖「别的调用方刚刷过」的竞态。刷新参数（client_id、
 * token 端点）与 pi-ai 各 provider 的实现一字不差：凭据是 pi-ai 登录发的，续命也必须
 * 用同一个 OAuth client，否则 refresh token 不认。
 *
 * xAI 的 access token 寿命约 6 小时，OpenAI codex 约 10 天，所以 xAI 更依赖这条
 * 刷新路径。刷新失败（如 refresh token 被吊销）时抛错，提示重新登录。
 */

import { credentialKey } from "@deepseek-ai/dsh-credentials";

const CREDENTIAL_SCOPE = "llm-pi-ai";

/** 提前刷新的余量：与 pi-ai resolve.js 的 DEFAULT_OAUTH_MINIMUM_VALIDITY_MS 一致。 */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

/** 各 provider 的刷新端点与 client_id，取自 pi-ai 对应 provider 的 OAuth 模块。 */
const REFRESH_PROVIDERS = {
  xai: {
    label: "xAI",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  },
  "openai-codex": {
    label: "openai-codex",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  },
};

/**
 * 取一个 provider 的 OAuth access token，过期（或临近过期）时先刷新并写回。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials `ctx.credentials`
 * @param {string} providerId pi-ai provider id，如 "xai"、"openai-codex"
 * @returns {Promise<{accessToken: string, payload: Record<string, unknown>}>}
 */
export async function oauthCredential(credentials, providerId, signal) {
  const key = credentialKey(CREDENTIAL_SCOPE, providerId);
  const record = await credentials.readRecord(key);
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
  const expires = numberish(payload.expires) ?? numberish(payload.expires_at);
  const needsRefresh = expires !== undefined && expires - REFRESH_LEAD_MS <= Date.now();
  return needsRefresh ? refreshCredential(credentials, providerId, key, signal) : { accessToken, payload };
}

/**
 * 刷新一次并返回新 access token。在 modifyRecord 的锁内 read-decide-replace：
 * 进锁后先用当前值判断，别的调用方刚刷过就直接用它的结果。
 */
async function refreshCredential(credentials, providerId, key, signal) {
  const provider = REFRESH_PROVIDERS[providerId];
  if (!provider) {
    // 没登记刷新参数的 provider 维持旧行为：直接用存量 access token。
    const record = await credentials.readRecord(key);
    const payload = record?.payload;
    const accessToken = payload && accessOf(payload);
    if (!accessToken) {
      throw new Error(`${providerId} 凭据里没有 access token。重新登录 ${providerId}。`);
    }
    return { accessToken, payload };
  }

  let settled;
  const record = await credentials.modifyRecord(key, async (current) => {
    const payload = current?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const accessToken = accessOf(payload);
    const expires = numberish(payload.expires) ?? numberish(payload.expires_at);
    if (accessToken && (expires === undefined || expires - REFRESH_LEAD_MS > Date.now())) {
      // 别的调用方已刷新过（modifyRecord 锁内已与磁盘对账），不再重复刷。
      settled = { accessToken, payload };
      return undefined;
    }
    const refreshToken = stringOf(payload.refresh);
    if (!refreshToken) {
      throw new Error(`${providerId} 凭据里没有 refresh token，无法自动刷新。重新登录 ${providerId}。`);
    }
    const next = await requestTokenRefresh(provider, refreshToken, signal);
    // 合并而不是替换：codex 的 payload 里还有 accountId 等字段，刷新响应里没有。
    return { ...current, kind: "grant", payload: { ...payload, ...next } };
  });
  if (settled) return settled;

  const payload = record?.payload;
  const accessToken = payload && accessOf(payload);
  if (!accessToken) {
    throw new Error(`${providerId} 刷新后仍没有 access token。重新登录 ${providerId}。`);
  }
  return { accessToken, payload };
}

/** POST token 端点换新令牌，返回要并进 payload 的字段。 */
async function requestTokenRefresh(provider, refreshToken, signal) {
  let response;
  try {
    response = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: provider.clientId,
        refresh_token: refreshToken,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("操作已取消");
    throw new Error(`${provider.label} 令牌刷新请求失败：${errorMessage(error)}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${provider.label} 令牌刷新返回的不是 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok || !stringOf(body?.access_token)) {
    throw new Error(
      `${provider.label} 令牌刷新失败（HTTP ${response.status}），重新登录：${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  const expiresIn = numberish(body.expires_in) ?? 3600;
  return {
    access: stringOf(body.access_token),
    // xAI 不轮换 refresh token 时响应里没有 refresh_token，沿用旧的。
    refresh: stringOf(body.refresh_token) ?? refreshToken,
    expires: Date.now() + expiresIn * 1000,
  };
}

/**
 * 看一个 provider 现在有没有可用凭据。只读，不触发登录，供设置页显示状态用。
 * 过期在这里只意味着「下次调用会先刷新」，不再等于「必须重新登录」。
 */
export async function credentialStatus(credentials, providerId) {
  const record = await credentials.readRecord(credentialKey(CREDENTIAL_SCOPE, providerId));
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") return { authorized: false, expired: false };
  if (!accessOf(payload)) return { authorized: false, expired: false };
  const expires = numberish(payload.expires) ?? numberish(payload.expires_at);
  const refreshable = REFRESH_PROVIDERS[providerId] !== undefined && !!stringOf(payload.refresh);
  if (expires === undefined) return { authorized: true, expired: false };
  return { authorized: true, expired: expires <= Date.now() && !refreshable, expires };
}

/**
 * ChatGPT 凭据 = access token + account id。account id 优先取 payload.accountId，
 * 没有就从 access token 的 JWT 载荷里解（claim `https://api.openai.com/auth`.chatgpt_account_id）。
 * @param {import("@deepseek-ai/dsh-credentials").CredentialProvider} credentials
 * @returns {Promise<{accessToken: string, accountId: string}>}
 */
export async function codexCredentials(credentials, signal) {
  const { accessToken, payload } = await oauthCredential(credentials, "openai-codex", signal);
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

/** payload 里的 access token，兼容 access / access_token / token 三种字段名。 */
function accessOf(payload) {
  return stringOf(payload.access) ?? stringOf(payload.access_token) ?? stringOf(payload.token);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function stringOf(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberish(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
