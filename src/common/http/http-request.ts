/**
 * @fileoverview 提供 HTTP adapter 中立的请求读取函数；不负责认证决策或响应写入。
 * @module common/http
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：HTTP Guard 从 Nest/Fastify 请求取得该最小结构，再调用 readHttpHeader 或 requestPath；
 * 输入是 adapter 提供的请求元数据，输出为 header 或无查询路径。无 I/O 副作用。
 * 安全边界：工具只读取和规范化，不证明 token 有效或资源归属；调用方必须继续执行恒定时间比较、
 * 会话验签或领域所有权校验，且不能把 query 中的敏感值写入鉴权逻辑。
 */

/** Guard 所需的 adapter 中立请求视图，避免 common/security 依赖 Express/Fastify 具体类型。 */
export interface HttpRequestLike {
  /** HTTP 方法，由服务器 adapter 生产；路由门禁按大写标准值比较。 */
  readonly method: string;
  /** 原始请求 URL，可能包含 query string；requestPath 仅提取路径部分。 */
  readonly url: string;
  /** adapter 规范化后的 header 映射；键按小写读取，值可能为多值数组。 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * 读取规范化 HTTP header；多值 header 只接受首个值。
 * @param request Nest adapter 提供的最小请求视图，headers 尚未建立业务信任。
 * @param name 调用方指定的 header 名；函数统一转换为小写查找。
 * @returns 首个字符串值，缺失时为 undefined；不验证 token 格式或内容。
 */
export function readHttpHeader(
  request: HttpRequestLike,
  name: string,
): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @param request Nest adapter 提供的请求视图。
 * @returns 不含 query string 的原始路径，供公开路由和内部 API 认证域判断。
 */
export function requestPath(request: HttpRequestLike): string {
  const queryIndex = request.url.indexOf("?");
  return queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
}
