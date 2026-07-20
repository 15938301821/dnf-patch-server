import { z } from "zod";

export const idSchema = z.uuid();
export const clientIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/u);
export const sha256Schema = z.string().regex(/^[A-Fa-f0-9]{64}$/u);
export const boundedJsonRecordSchema = z
  .record(z.string().min(1).max(128), z.json())
  .superRefine((value, context) => {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > 65_536) {
      context.addIssue({
        code: "custom",
        message: "JSON 对象不能超过 64 KiB。",
      });
    }
    if (exceedsJsonBudget(value, 16, 10_000)) {
      context.addIssue({
        code: "custom",
        message: "JSON 对象层级或节点数量超过限制。",
      });
    }
  });
export const safeDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((value) => !hasUnsafeDisplayNameCharacter(value), {
    message: "名称包含不安全字符。",
  });
export const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => {
      const normalizedPath = value.replaceAll("\\", "/");
      return (
        !normalizedPath.startsWith("/") &&
        !/^[A-Za-z]:/u.test(normalizedPath) &&
        !normalizedPath.split("/").includes("..")
      );
    },
    { message: "必须提供安全的仓库相对路径。" },
  );

function hasUnsafeDisplayNameCharacter(value: string): boolean {
  if (/[<>:"/\\|?*]/u.test(value)) {
    return true;
  }
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint <= 0x1f;
  });
}

function exceedsJsonBudget(
  root: Record<string, unknown>,
  maxDepth: number,
  maxNodes: number,
): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 1, value: root },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maxNodes || current.depth > maxDepth) return true;
    if (current.value === null || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}
