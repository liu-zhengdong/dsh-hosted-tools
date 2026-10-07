/**
 * 异步托管工具的任务账本。
 *
 * 异步调用（配置 mode 里选 "async" 或默认异步的那种）走这里：工具调用立刻返回一个
 * jobId，真正的工作留在后台，跑完把结果以一条 user 消息注入该会话（agent.followup）。
 *
 * 只在进程内记：任务跑在本进程里，DSH 重启它就没了，写盘没有可恢复的东西
 * （结果本来就已经注入进对话，会话记录里有）。所以是一个有界的 Map，不做文件、不做重试。
 */

/** @typedef {"running"|"done"|"failed"} JobStatus */

/** 完成记录在内存里最多留这么多条，超出丢掉最旧的。 */
const MAX_FINISHED = 20;

/** @type {Map<string, JobRecord>} */
const jobs = new Map();

/**
 * @typedef {object} JobRecord
 * @property {string} jobId
 * @property {string} toolId 注册表 id，如 `xai/web-search`
 * @property {string} tool 工具名，如 `xai_web_search`
 * @property {string} label
 * @property {string} argsBrief 一行参数摘要
 * @property {number} startedAt
 * @property {number} [finishedAt]
 * @property {JobStatus} status
 * @property {string} [summary] 完成时的一行摘要，或失败原因
 * @property {AbortController} controller
 * @property {(text: string, job: JobRecord) => void} deliver 把结果注入对话的回调（按次绑定）
 */

/**
 * 启动一个后台任务：登记并返回 jobId 与它的取消信号。
 * @param {{toolId: string, tool: string, label: string, argsBrief: string}} init
 * @param {(text: string, job: JobRecord) => void} deliver
 */
export function startJob(init, deliver) {
  const jobId = newJobId();
  const controller = new AbortController();
  jobs.set(jobId, {
    jobId,
    toolId: init.toolId,
    tool: init.tool,
    label: init.label,
    argsBrief: init.argsBrief,
    startedAt: Date.now(),
    status: "running",
    controller,
    deliver,
  });
  return { jobId, controller };
}

/** 收尾：记状态与摘要，并把结果注入对话。 */
export function finishJob(jobId, status, summary, delivery) {
  const job = jobs.get(jobId);
  if (!job || job.status !== "running") return;
  job.status = status;
  job.finishedAt = Date.now();
  job.summary = summary;
  prune();
  try {
    job.deliver(delivery, job);
  } catch {
    // 会话可能已经结束；结果留在任务记录里，不再重试。
  }
}

export function listJobs() {
  const all = [...jobs.values()];
  all.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return b.startedAt - a.startedAt;
  });
  return all;
}

/** 按完整 id 或前缀找一个任务。 */
export function findJob(ref, onlyRunning = false) {
  const matches = [...jobs.values()].filter(
    (job) => (job.jobId === ref || job.jobId.startsWith(ref)) && (!onlyRunning || job.status === "running"),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** 取消一个还在跑的任务；返回失败原因时说明为什么没取消成。 */
export function cancelJob(ref) {
  const exact = jobs.get(ref);
  if (exact) {
    if (exact.status !== "running") {
      return { ok: false, error: `任务 ${exact.jobId} 已经${exact.status === "done" ? "完成" : "失败"}` };
    }
    exact.controller.abort();
    return { ok: true };
  }
  const matches = [...jobs.values()].filter((job) => job.jobId.startsWith(ref));
  if (matches.length === 0) return { ok: false, error: `没有找到任务 ${ref}` };
  if (matches.length > 1) return { ok: false, error: `${ref} 匹配到多个任务，请写完整 id` };
  const target = matches[0];
  if (target.status !== "running") return { ok: false, error: `任务 ${target.jobId} 已经结束` };
  target.controller.abort();
  return { ok: true };
}

/** `12s` / `1m12s`。 */
export function formatElapsed(startedAt, finishedAt) {
  const seconds = Math.max(0, Math.round(((finishedAt ?? Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** 一行：`- h1a2b3 运行中 xai_web_search 12s 今天的科技新闻`。 */
export function renderJobLine(job) {
  const state = job.status === "running" ? "运行中" : job.status === "done" ? "完成" : "失败";
  const detail = job.status === "running" ? job.argsBrief : (job.summary ?? "");
  return `- ${job.jobId} ${state} ${job.tool} ${formatElapsed(job.startedAt, job.finishedAt)} ${detail}`.trimEnd();
}

/** 任务清单：在跑的在前面，各带一行摘要。 */
export function renderJobs() {
  const all = listJobs();
  if (all.length === 0) return "没有后台任务记录。";
  const running = all.filter((job) => job.status === "running").length;
  return [
    `后台任务 ${running} 个在跑，共 ${all.length} 条记录：`,
    ...all.slice(0, MAX_FINISHED).map((job) => renderJobLine(job)),
  ].join("\n");
}

function newJobId() {
  const time = Date.now().toString(36).slice(-5);
  const random = Math.random().toString(36).slice(2, 5);
  return `h${time}${random}`;
}

/** 只裁完成记录：还在跑的一律留着。 */
function prune() {
  const finished = [...jobs.values()].filter((job) => job.status !== "running").sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) jobs.delete(job.jobId);
}
