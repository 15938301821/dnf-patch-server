export interface OpenAiEndpoint {
  baseUrl: string;
  identity: string;
  custom: boolean;
}

/**
 * 固定 OpenAI 兼容端点边界。返回值不含密钥、查询参数或用户凭据，
 * `identity` 可安全写入模型证据。
 */
export function resolveOpenAiEndpoint(value: string): OpenAiEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OPENAI_BASE_URL 必须是绝对 URL。");
  }
  if (url.protocol !== "https:") {
    throw new Error("OPENAI_BASE_URL 必须使用 HTTPS。");
  }
  if (url.username || url.password) {
    throw new Error("OPENAI_BASE_URL 不能包含凭据。");
  }
  if (url.search || url.hash) {
    throw new Error("OPENAI_BASE_URL 不能包含查询参数或 fragment。");
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname !== "/v1" && !pathname.endsWith("/v1")) {
    throw new Error("OPENAI_BASE_URL 必须包含兼容 API 的 /v1 路径。");
  }
  url.pathname = pathname;
  const baseUrl = url.toString().replace(/\/$/u, "");
  return {
    baseUrl,
    identity: `${url.host}${pathname}`,
    custom: baseUrl !== "https://api.openai.com/v1",
  };
}
