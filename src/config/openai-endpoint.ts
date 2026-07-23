/**
 * @fileoverview 规范化固定角色模型使用的 OpenAI 兼容 HTTPS 端点并生成脱敏身份；不接收 API
 * Key、不发起网络请求，也不判断外部 Provider 是否实际支持配置模型。
 * @module config/openai-endpoint
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：环境 schema 与用户模型配置校验调用 resolveOpenAiEndpoint，下游模型 Service 使用
 * baseUrl 发起受控请求并将 identity 写入脱敏审计。输入为尚未信任的 URL 字符串，输出不含凭据
 * 或查询参数；无 I/O 副作用。安全边界：只允许 HTTPS 和 `/v1` 路径，解析失败必须 fail-closed。
 */

/** 模型调用层消费的规范化端点；该结构不是用户凭据 DTO。 */
export interface OpenAiEndpoint {
  /** 可传给固定模型客户端的无尾斜杠 HTTPS `/v1` URL。 */
  baseUrl: string;
  /** 可持久化审计的 `host + path`，不含协议凭据、查询或 fragment。 */
  identity: string;
  /** 是否偏离服务内置默认端点；不代表端点已授权或可达。 */
  custom: boolean;
}

/**
 * 固定 OpenAI 兼容端点边界。返回值不含密钥、查询参数或用户凭据，
 * `identity` 可安全写入模型证据。
 *
 * @param value 来自环境或受认证模型配置 DTO、尚未建立信任的端点字符串。
 * @returns 规范化 baseUrl、脱敏 identity 和是否自定义的标志；不证明网络可达或模型兼容。
 * @throws Error 当值不是绝对 URL、不是 HTTPS、内嵌凭据/查询/fragment 或缺少 `/v1` 路径时抛出。
 */
export function resolveOpenAiEndpoint(value: string): OpenAiEndpoint {
  // 步骤 1：先使用结构化 URL 解析，拒绝相对地址和无法可靠拆分的字符串。
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OPENAI_BASE_URL 必须是绝对 URL。");
  }
  // 步骤 2：在任何模型网络调用前锁定传输协议并移除可能泄密的 URL 组成部分。
  if (url.protocol !== "https:") {
    throw new Error("OPENAI_BASE_URL 必须使用 HTTPS。");
  }
  if (url.username || url.password) {
    throw new Error("OPENAI_BASE_URL 不能包含凭据。");
  }
  if (url.search || url.hash) {
    throw new Error("OPENAI_BASE_URL 不能包含查询参数或 fragment。");
  }
  // 步骤 3：规范化兼容 API 路径，用同一结果同时驱动请求地址和脱敏审计身份。
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname !== "/v1" && !pathname.endsWith("/v1")) {
    throw new Error("OPENAI_BASE_URL 必须包含兼容 API 的 /v1 路径。");
  }
  url.pathname = pathname;
  const baseUrl = url.toString().replace(/\/$/u, "");
  return {
    baseUrl,
    identity: `${url.host}${pathname}`,
    custom: baseUrl !== "https://kldai.cc/v1",
  };
}
