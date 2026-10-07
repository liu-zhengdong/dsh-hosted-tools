/**
 * hostedToolsAuth —— 给 Web GUI 用的 OAuth 登录 Remote 命名空间。
 *
 * DSH 的 AuthorizationService 已经由 dsh-llm-pi-ai 注册了各 provider 的登录流
 * （flow key 形如 "llm-pi-ai/xai"），但它只提供宿主内 API，没有任何现成的
 * Remote 端点把它暴露给客户端。这个服务把 `ctx.authorization` 桥接出去：
 *
 * - flows()                     列出已注册的登录流（key、label、methods、inFlight）。
 * - status()                    列出本插件用到的 provider 的凭据现状（authorized/expired）。
 * - begin(key, method)          stream：跑一次登录流，把交互事件逐条推给客户端：
 *     {type:"notice", notice:{message?, url?, code?}}          —— 认证 URL/设备码等
 *     {type:"prompt", requestId, prompt:{kind, message?, placeholder?, options?}}
 *     {type:"prompt-done", requestId}                          —— 客户端已作答
 *     {type:"settled", status:"authorized"|"cancelled", key}   —— 正常结束
 *     {type:"failed", code?, message, key}                     —— 流程抛错
 * - respond(requestId, answer)  回答一个挂起的 prompt（select 回 option 值，
 *                               text/secret/manual_code 回字符串，confirm 回布尔）。
 * - cancel(key)                 取消该 key 正在跑的登录尝试（取消按钮、关掉弹层用）。
 *
 * 插件解析不到 asar 内部的 @deepseek-ai/dsh-typert-protocol，所以
 * TypertRemoteService 做的两件事在这里手工复刻：
 * 1) 实例上挂 typertRemote 绑定 {service, serviceKey, namespace} —— Gateway 的
 *    SRC fallback（resolveSrcDescriptor）靠它找到命名空间；
 * 2) 原型上挂 REMOTE_METHOD_DESCRIPTOR（version:1 的 methods 标记数组）——
 *    remoteMethods() 从这里读导出方法名与 stream 模式。
 * SRC fallback 用 Function.prototype.toString 解析参数名，所以这些方法必须是
 * 普通类方法、参数是简单标识符；末位参数名为 signal 时被当作取消信号。
 */

import { credentialStatus } from "./credentials.js";

const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

const NAMESPACE = "hostedToolsAuth";
const SERVICE_KEY = "hostedToolsAuth";

/** 设置页要显示状态的 provider：正好是本插件工具用到的两个。 */
const STATUS_PROVIDERS = ["xai", "openai-codex"];

function log(text) {
  process.stderr.write(`dsh-hosted-tools: ${text}\n`);
}

/** 往类原型上写 remote-methods 描述符（等价于 @Remote / @Remote({mode:"stream"})）。 */
function markRemote(prototype, entries) {
  const methods = entries.map(({ method, mode }) =>
    Object.freeze({
      method,
      ...(mode === undefined ? {} : { mode }),
      invocation: Object.freeze({ kind: "direct" }),
    }),
  );
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(methods) }),
  });
}

/** 一个 key 一条事件队列：flow 回调推事件进来，begin 的 generator 逐条吐给下游。 */
function makeQueue() {
  const items = [];
  const waiters = [];
  const q = {
    done: false,
    push(item) {
      const w = waiters.shift();
      if (w) w({ value: item, done: false });
      else items.push(item);
    },
    close() {
      q.done = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    next() {
      if (items.length) return Promise.resolve({ value: items.shift(), done: false });
      if (q.done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
  return q;
}

/**
 * stream 里每一帧都要通过 Gateway 的无损 JSON 校验，而 pi-ai 的交互事件带着
 * AbortSignal 一类不能序列化的对象，所以推给客户端前只留协议约定的字段。
 * @param notice - pi-ai 的 notify 事件。
 * @returns {{message?: string, url?: string, code?: string}}
 */
function noticePayload(notice) {
  const out = {};
  if (typeof notice?.message === "string") out.message = notice.message;
  if (typeof notice?.url === "string") out.url = notice.url;
  if (typeof notice?.code === "string") out.code = notice.code;
  return out;
}

/**
 * prompt 白名单：pi-ai 会在 prompt 上挂 AbortSignal（signal），必须丢掉。
 * @param prompt - pi-ai 的 prompt 请求。
 * @returns {{kind: string, message?: string, placeholder?: string, options?: {id: string, label: string}[]}}
 */
function promptPayload(prompt) {
  const out = { kind: typeof prompt?.kind === "string" ? prompt.kind : "text" };
  if (typeof prompt?.message === "string") out.message = prompt.message;
  if (typeof prompt?.placeholder === "string") out.placeholder = prompt.placeholder;
  if (Array.isArray(prompt?.options)) {
    out.options = prompt.options
      .map((option) => {
        if (typeof option === "string") return { id: option, label: option };
        const id = option?.id ?? option?.value;
        if (typeof id !== "string") return undefined;
        return { id, label: typeof option?.label === "string" ? option.label : id };
      })
      .filter((option) => option !== undefined);
  }
  return out;
}

class HostedToolsAuthService {
  constructor(ctx) {
    this.ctx = ctx;
    /** requestId -> {resolve, key}：挂起等客户端 respond 的 prompt。 */
    this.pending = new Map();
    /** key -> queue：正在跑的 begin stream 的事件队列。 */
    this.queues = new Map();
    this.seq = 0;
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_KEY,
      namespace: NAMESPACE,
    });
  }

  /** 列出 AuthorizationService 里注册的全部登录流（只留无损 JSON 字段）。 */
  flows() {
    return this.ctx.authorization.list().map((flow) => ({
      key: String(flow.key),
      label: typeof flow.label === "string" ? flow.label : String(flow.key),
      methods: (Array.isArray(flow.methods) ? flow.methods : []).map((method) => ({
        id: String(method.id),
        label: typeof method.label === "string" ? method.label : String(method.id),
      })),
      inFlight: flow.inFlight === true,
    }));
  }

  /** 各 provider 的凭据现状，供设置页显示「已登录 / 未登录 / 已过期」。 */
  async status() {
    const entries = [];
    for (const provider of STATUS_PROVIDERS) {
      try {
        entries.push({ provider, ...(await credentialStatus(this.ctx.credentials, provider)) });
      } catch (error) {
        entries.push({
          provider,
          authorized: false,
          expired: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return entries;
  }

  /** 取消某 key 的登录尝试。 */
  cancel(key) {
    this.ctx.authorization.cancel(key);
    return true;
  }

  /** 客户端回答一个挂起的 prompt；requestId 对不上时回 false。 */
  respond(requestId, answer) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(answer);
    return true;
  }

  async *begin(key, method, signal) {
    const queue = makeQueue();
    this.queues.set(key, queue);
    const interaction = {
      notify: (notice) => queue.push({ type: "notice", notice: noticePayload(notice) }),
      prompt: (prompt) => {
        const requestId = `${key}#${++this.seq}`;
        const answer = new Promise((resolve) => {
          this.pending.set(requestId, { resolve, key });
        });
        queue.push({ type: "prompt", requestId, prompt: promptPayload(prompt) });
        return answer.then((value) => {
          queue.push({ type: "prompt-done", requestId });
          return value;
        });
      },
    };
    // 并发跑登录流；结果（或错误）也走同一条队列，generator 顺序吐出去。
    this.ctx.authorization
      .begin({ key, method, signal, interaction })
      .then((outcome) => queue.push({ type: "settled", status: outcome.status, key }))
      .catch((error) =>
        queue.push({
          type: "failed",
          key,
          code: error?.code,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => queue.close());
    try {
      while (true) {
        const { value, done } = await queue.next();
        if (done) return;
        yield value;
      }
    } finally {
      // 客户端中止 stream（关掉弹层/断连）：撤回尝试并结清挂起的 prompt。
      this.queues.delete(key);
      this.ctx.authorization.cancel(key);
      for (const [id, entry] of this.pending) {
        if (entry.key !== key) continue;
        this.pending.delete(id);
        entry.resolve(undefined);
      }
    }
  }
}

markRemote(HostedToolsAuthService.prototype, [
  { method: "flows" },
  { method: "status" },
  { method: "cancel" },
  { method: "respond" },
  { method: "begin", mode: "stream" },
]);

/**
 * 在插件 apply 里调用：注册成 cordis 服务，key 与 namespace 同名。
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function installAuthRemote(ctx) {
  ctx.provide(SERVICE_KEY, new HostedToolsAuthService(ctx));
  log(`Remote 命名空间 ${NAMESPACE} 已挂载（flows/status/begin/respond/cancel）`);
}
