/**
 * @fileoverview 提供 HTTP adapter 中立的请求读取函数；不负责认证决策或响应写入。
 * @module common/http
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（修复开发启动时 Express 依赖的异常探测）
 */

export interface HttpRequestLike {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** 读取规范化 HTTP header；多值 header 只接受首个值。 */
export function readHttpHeader(
  request: HttpRequestLike,
  name: string,
): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** 返回不含 query string 的请求路径，用于公开路由与鉴权边界判断。 */
export function requestPath(request: HttpRequestLike): string {
  const queryIndex = request.url.indexOf("?");
  return queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
}
