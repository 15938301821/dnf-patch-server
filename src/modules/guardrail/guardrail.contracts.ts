import { z } from "zod";
import {
  boundedJsonRecordSchema,
  clientIdSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

const forbiddenDeclarativeKeyFragments = new Set([
  "command",
  "executable",
  "shell",
  "scriptpath",
  "scriptfile",
  "process",
  "gameprocess",
  "directory",
  "gamedirectory",
  "path",
  "filepath",
]);

export const allowedJobKindSchema = z.enum([
  "context-freeze",
  "inventory",
  "engineering-plan",
  "image-reference",
  "aseprite-adaptation",
  "npk-package",
  "independent-validation",
  "manual-review",
  "bpk-package",
  "shared-fx",
  "profession",
]);

export const guardrailInputSchema = z
  .object({
    policyId: clientIdSchema,
    policySha256: sha256Schema,
    jobKind: allowedJobKindSchema,
    payload: boundedJsonRecordSchema,
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict();

export type AllowedJobKind = z.infer<typeof allowedJobKindSchema>;
export type GuardrailInput = z.infer<typeof guardrailInputSchema>;

/**
 * 检查声明式 Job 数据是否携带执行入口或本机路径；不读取文件，也不解析资源名称。
 * @param value 待检查的已解析 JSON 值。
 * @returns 存在执行字段、路径字段或不安全路径值时返回 true。
 */
export function containsUnsafeDeclarativeField(value: unknown): boolean {
  if (typeof value === "string") return isUnsafePathValue(value);
  if (Array.isArray(value)) {
    return value.some(containsUnsafeDeclarativeField);
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      isForbiddenDeclarativeKey(key) || containsUnsafeDeclarativeField(child),
  );
}

export const declarativeParametersSchema = boundedJsonRecordSchema.superRefine(
  (value, context) => {
    if (containsUnsafeDeclarativeField(value)) {
      context.addIssue({
        code: "custom",
        message: "任务参数不能包含执行入口或不安全路径。",
      });
    }
  },
);

export interface GuardrailEvaluation {
  policyId: string;
  policySha256: string;
  inputSha256: string;
  decision: "allow" | "deny";
  reasonCode: string;
}

export interface GuardrailDecisionView {
  id: string;
  runId: string;
  policyId: string;
  policySha256: string;
  inputSha256: string;
  decision: "allow" | "deny";
  reasonCode: string;
  createdAtUtc: string;
}

function isForbiddenDeclarativeKey(key: string): boolean {
  const normalized = key
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s_-]+/gu, "");
  return (
    forbiddenDeclarativeKeyFragments.has(normalized) ||
    normalized.startsWith("command") ||
    normalized.startsWith("executable") ||
    normalized.startsWith("shell") ||
    normalized.startsWith("script") ||
    normalized.endsWith("path") ||
    normalized.includes("directory") ||
    normalized.includes("process")
  );
}

function isUnsafePathValue(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ||
    normalized.split("/").includes("..")
  );
}
