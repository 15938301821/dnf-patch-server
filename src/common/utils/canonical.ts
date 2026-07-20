import { createHash } from "node:crypto";

export function canonicalName(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value), "utf8")
    .digest("hex")
    .toUpperCase();
}

/** 新记录使用的确定性 JSON 哈希；对象键按 UTF-16 code unit 排序。 */
export function sha256JcsV1(value: unknown): string {
  return createHash("sha256")
    .update(stableStringifyJcsV1(value), "utf8")
    .digest("hex")
    .toUpperCase();
}

export function stableStringifyJcsV1(value: unknown): string {
  return encodeJcsV1(value);
}

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
