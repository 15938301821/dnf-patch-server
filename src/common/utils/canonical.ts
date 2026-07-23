/**
 * @fileoverview 提供名称规范化、旧版稳定 JSON 与 JCS v1 确定性序列化/哈希纯函数；不校验领域
 * DTO、JSON 预算或哈希所指对象的真实性。
 * @module common/utils
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：领域 Service 在生成请求指纹、证据摘要或规范化名称时调用；输入必须已通过相应
 * schema，输出为字符串或 SHA-256 十六进制摘要。副作用仅使用进程内 CPU/内存。
 * 安全边界：同一协议版本必须固定使用同一序列化函数；摘要相同只证明规范化字节相同，不证明
 * Artifact 内容兼容、已部署或来源可信。非 JSON 值在 JCS v1 路径必须 fail-closed。
 */
import { createHash } from "node:crypto";

/**
 * @param value 已通过长度/字符校验的业务名称。
 * @returns NFC Unicode 规范化并按当前运行时 locale 小写化的名称键；不修改输入。
 */
export function canonicalName(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

/**
 * 使用历史 localeCompare 键顺序生成稳定 JSON，保留既有记录兼容性。
 * @param value 调用方提供的可 JSON.stringify 值；本函数不执行预算校验。
 * @returns 递归排序对象键后的 JSON 字符串。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

/**
 * @param value 需要按旧版稳定 JSON 规则计算摘要的已校验值。
 * @returns 大写 SHA-256 十六进制摘要；不证明输入来源或业务授权。
 */
export function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex")
    .toUpperCase();
}

/**
 * 为新记录计算 JCS v1 确定性 JSON 摘要；对象键按 UTF-16 code unit 排序。
 * @param value 经 DTO/数据库 JSON schema 校验的可序列化 JSON 值。
 * @returns 大写 SHA-256 十六进制摘要。
 * @throws TypeError 当值含非有限数字、undefined、函数或其他非 JSON 类型时抛出。
 */
export function sha256JcsV1(value: unknown): string {
  return createHash("sha256")
    .update(stableStringifyJcsV1(value), "utf8")
    .digest("hex")
    .toUpperCase();
}

/**
 * @param value 经运行时 schema 校验的 JSON 值。
 * @returns JCS v1 规则下的确定性 JSON 字符串。
 * @throws TypeError 当递归遇到不可序列化 JSON 的值时抛出，调用方不得降级到不稳定编码。
 */
export function stableStringifyJcsV1(value: unknown): string {
  return encodeJcsV1(value);
}

/**
 * 递归复制并按 localeCompare 排序对象键，供历史指纹保持兼容。
 * @param value 旧版稳定序列化输入。
 * @returns 排序后的新数组/对象或原始标量，不修改输入。
 */
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

/**
 * 递归编码严格 JSON 值，并按默认 UTF-16 code unit 顺序排列对象键。
 * @param value 尚未在本函数内建立类型信任的候选 JSON 节点。
 * @returns 当前节点的确定性 JSON 片段。
 * @throws TypeError 数字非有限或节点不是 JSON 类型时抛出。
 */
function encodeJcsV1(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS 数字必须是有限值。");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encodeJcsV1).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeJcsV1(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("JCS 输入必须是可序列化 JSON 值。");
}
