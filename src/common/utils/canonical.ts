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
