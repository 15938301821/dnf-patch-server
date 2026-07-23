/**
 * @fileoverview 定义声明式 Job Guardrail 的输入、决策和递归安全字段校验；不创建 Run、Job 或数据库
 * 决策记录，也不执行、解析或访问任何本机路径。
 * @module modules/guardrail/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Factory 与 Job contract 使用 allowedJobKindSchema 限制声明；GuardrailService 调用
 * containsUnsafeDeclarativeField 生成确定性 allow/deny 决策；Run 创建事务再保存该决策及后续 Job。
 * 输入输出：输入是来自 HTTP 或冻结 Factory 的有界 JSON DTO，输出是已校验输入、允许 kind 和决策形状；
 * 不返回数据库行、工具路径或可执行指令。
 * 副作用：本文件只执行内存校验与规范化，不访问网络、数据库、对象存储或游戏资源。
 * 安全边界：Guardrail 指创建执行任务前的 fail-closed 决策。它递归拒绝命令、脚本、进程和路径字段，
 * 防止声明式 payload 被变成 Worker 的任意执行入口；允许某个 enum kind 不代表已有 Worker capability。
 */
import { z } from "zod";
import {
  boundedJsonRecordSchema,
  clientIdSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

/**
 * 归一化后仍禁止出现在声明式 payload 中的执行控制字段片段。
 * NFKC、大小写和连接符归一化在下游函数中完成，避免 `script_path` 等变体绕过只检查精确键名的实现。
 */
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

/**
 * Factory 与 Job contract 可声明的受控 Job kind。
 * 这是线协议白名单，不等于每个 kind 已有 Handler、Worker 注册或真实工具链。
 */
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

/**
 * GuardrailService 的严格输入 DTO。
 * deploymentAuthorized 固定为 false；调用方不能通过 payload、策略名称或模型结果提升部署授权。
 */
export const guardrailInputSchema = z
  .object({
    policyId: clientIdSchema,
    policySha256: sha256Schema,
    jobKind: allowedJobKindSchema,
    payload: boundedJsonRecordSchema,
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict();

/** 经过 allowedJobKindSchema 校验的声明式 Job kind。 */
export type AllowedJobKind = z.infer<typeof allowedJobKindSchema>;

/** GuardrailService 接收的已解析策略、kind 与有界 payload，不是 Worker 的本机执行参数。 */
export type GuardrailInput = z.infer<typeof guardrailInputSchema>;

/**
 * 递归检查声明式 Job 数据是否携带执行入口或本机路径；不读取文件，也不解析资源名称。
 *
 * 调用关系：declarativeParametersSchema 和 GuardrailService 都调用此函数，保证 HTTP 输入与冻结
 * payload 在同一安全语义下被拒绝。字符串值会检查绝对/URL/父目录路径，对象键会先归一化再检查。
 *
 * @param value 已解析但仍不可信的 JSON 值；可能是字符串、数组、对象或原始值。
 * @returns 存在执行字段、路径字段或不安全路径值时返回 true；true 必须使上游拒绝创建 Worker Job。
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

/**
 * 供版本化 Job contract 复用的有界声明式 parameters schema。
 * 除 JSON 大小/深度预算外，superRefine 还拒绝任意执行入口；解析成功不代表资源映射或 Worker 可用。
 */
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

/**
 * GuardrailService 在内存中生成的确定性评估结果。
 * inputSha256 绑定完整已解析输入，Run 事务随后把该结果转换为可审计的持久化 Guardrail 决策。
 */
export interface GuardrailEvaluation {
  policyId: string;
  policySha256: string;
  inputSha256: string;
  decision: "allow" | "deny";
  reasonCode: string;
}

/**
 * 对调用方公开的已持久化 Guardrail 决策 ViewModel。
 * allow 只表示当前策略检查通过，不证明 Job 已领取、Worker 可用、Artifact 已验证或部署获授权。
 */
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

/**
 * 将对象键做 Unicode、大小写和分隔符归一化后识别执行控制语义。
 * @param key payload 中原始键名，可能故意使用全角字符、下划线或大小写绕过精确匹配。
 * @returns 键名表达命令、脚本、进程或路径控制时返回 true。
 */
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

/**
 * 拒绝会把声明式数据升级为本机或远程资源定位器的字符串值。
 * @param value payload 中原始字符串，不把普通相对标识或资源名称误判为路径。
 * @returns 绝对路径、盘符路径、URL 或含父目录段时返回 true。
 */
function isUnsafePathValue(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ||
    normalized.split("/").includes("..")
  );
}
