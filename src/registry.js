/**
 * 托管工具静态注册表。
 *
 * 从 pi-hosted-tools 的 src/registry.ts 移植。每一条对应官方文档里的一个事实，
 * 来源写在 source 里；没有官方来源的能力不进来。
 *
 * DSH 版的重要差别：DSH 的 LLM 层没有 `samplingParams` 透传口子，pi 版的 "hosted"
 * 执行方式（把服务端工具塞进推理请求）在 DSH 里不存在。所以迁移后所有工具都由插件
 * 自己发 HTTP 请求：`kind: "direct"` 照原样（本来就直接调端点），`kind: "hosted"`
 * 改成插件直接向 provider 的 Responses API POST，请求体里带 `tools: [{type}]`——
 * 工具仍在 provider 服务器上执行，只是发起请求的是插件而不是模型适配器。
 */

/**
 * @typedef {object} HostedToolSpec
 * @property {string} id 稳定 id：配置勾选、日志都用它。
 * @property {string} provider 拥有它的 provider id：凭据从 `llm-pi-ai` 凭据域里按这个 key 取。
 * @property {string} tool 勾选后注册给 DSH 的工具名。
 * @property {"hosted"|"direct"} kind pi 版语义：hosted = provider 服务端执行；direct = 插件独立请求。
 * @property {"supported"|"unsupported"|"unofficial"|"later"} status
 * @property {string} label
 * @property {string} description 给模型的描述；unsupported/later 只用于界面展示。
 * @property {"low"|"medium"|"high"} risk 计费风险。
 * @property {string} evidence 这条判断的官方依据（原文要点）。
 * @property {string} source
 * @property {boolean} implemented 本插件是否已实现。
 */

/** @type {HostedToolSpec[]} */
export const HOSTED_TOOLS = [
  // ---------------------------------------------------------------- OpenAI
  {
    id: "openai/web-search",
    provider: "openai-codex",
    tool: "openai_web_search",
    kind: "hosted",
    status: "supported",
    label: "OpenAI 网页搜索",
    description: "用 ChatGPT 侧的网页搜索查实时信息，返回答案与来源链接。",
    risk: "low",
    evidence: "官方 SIWC 限制页把 web search 列为支持（仍受模型与账号/工作区策略限制）",
    source: "https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations",
    implemented: true,
  },
  {
    id: "openai/image-generation",
    provider: "openai-codex",
    tool: "openai_image",
    kind: "direct",
    status: "unofficial",
    label: "OpenAI 图像生成（Codex 内部端点）",
    description: "走 Codex 内部 images 端点出图；官方不支持这条路，可用性没有承诺。",
    risk: "medium",
    evidence: "官方 SIWC 限制页明确把 image generation 列为不支持；实际可用的是 codex/images 内部端点",
    source: "https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations",
    implemented: true,
  },

  // ------------------------------------------------------------------- xAI
  {
    id: "xai/web-search",
    provider: "xai",
    tool: "xai_web_search",
    kind: "hosted",
    status: "supported",
    label: "Grok 网页搜索",
    description: "用 Grok 的服务端搜索查实时信息，返回带引用的答案。",
    risk: "low",
    evidence: "docs.x.ai 内置工具列表：web_search",
    source: "https://docs.x.ai/docs/tools/web-search",
    implemented: true,
  },
  {
    id: "xai/x-search",
    provider: "xai",
    tool: "xai_x_search",
    kind: "hosted",
    status: "supported",
    label: "Grok X 搜索",
    description: "检索 X 平台的实时内容与讨论。",
    risk: "low",
    evidence: "docs.x.ai 内置工具列表：x_search",
    source: "https://docs.x.ai/docs/tools/x-search",
    implemented: true,
  },
  {
    id: "xai/code-execution",
    provider: "xai",
    tool: "xai_code_execution",
    kind: "hosted",
    status: "supported",
    label: "Grok 代码执行",
    description: "在 xAI 远程沙盒里执行代码，用于计算与数据处理。",
    risk: "medium",
    evidence: "docs.x.ai 内置工具列表：code execution / code interpreter",
    source: "https://docs.x.ai/docs/tools/overview",
    implemented: true,
  },
  {
    id: "xai/image-generation",
    provider: "xai",
    tool: "xai_image_generate",
    kind: "direct",
    status: "supported",
    label: "Grok Imagine 出图",
    description: "用 Grok Imagine 生成图片，写回本地文件。",
    risk: "medium",
    evidence: "docs.x.ai 内置工具列表：image generation（Grok Imagine）；本插件走文档化的 images 端点以便控制模型与张数",
    source: "https://docs.x.ai/docs/tools/overview",
    implemented: true,
  },
  {
    id: "xai/image-edit",
    provider: "xai",
    tool: "xai_image_edit",
    kind: "direct",
    status: "supported",
    label: "Grok Imagine 改图",
    description: "按提示词编辑已有图片，写回本地文件。",
    risk: "medium",
    evidence: "docs.x.ai 图像接口支持 image edit（一次调用一图）",
    source: "https://docs.x.ai/docs/guides/image-generation",
    implemented: true,
  },
];

/**
 * 默认异步的托管工具：调用立刻返回一个 jobId，真正的工作留在后台，跑完把结果注入对话。
 * 判据是实测耗时（pi 版 README「验证」）：单次十几秒到几十秒的放异步，几秒内能回来的保持同步。
 * 用户可以在插件配置里逐个覆盖（见 EXPOSURE_MODES）。
 */
export const ASYNC_BY_DEFAULT = {
  "openai/image-generation": true, // 实测 21.4s
  "xai/web-search": true, // 实测 46.5s
  "xai/x-search": true, // 实测 40.6s
  "xai/code-execution": true, // 实测 12s
};

export const isAsyncByDefault = (id) => ASYNC_BY_DEFAULT[id] === true;

/**
 * 一个工具的暴露方式，也是插件配置里每个字段的取值：
 * - "off"：不注册给 DSH，模型看不到这个工具；
 * - "sync"：注册，调用等结果；
 * - "async"：注册，调用立刻回执，完成后把结果注入该会话。
 */
export const EXPOSURE_MODES = ["off", "sync", "async"];

/** 没有用户配置时每个工具的默认暴露方式。 */
export const defaultExposure = (id) => (isAsyncByDefault(id) ? "async" : "sync");

/** 计费风险的中文标签，只出现在配置界面的提示里。 */
export const RISK_LABELS = { low: "低", medium: "中", high: "高" };

export const implementedTools = () => HOSTED_TOOLS.filter((t) => t.implemented);

export const findTool = (id) => HOSTED_TOOLS.find((t) => t.id === id);
