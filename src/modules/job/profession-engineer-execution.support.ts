/**
 * @fileoverview 提供 Profession Engineer 编排的固定模型请求、确定性对象身份和稳定异常映射；
 * 不调用模型、数据库、对象存储或本机工具。
 * @module modules/job/profession-engineer-execution-support
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：ProfessionEngineerExecutionService 在每个副作用边界前后调用这些纯 helper。输入为
 * 冻结上下文、Repository 有限状态或对象证据，输出为固定请求/key，或抛出脱敏 Nest 业务异常。
 * 副作用：仅构造内存对象和异常；不记录 Prompt、访问网络或写持久化状态。
 * 安全边界：模型请求固定 engineer 角色/schema，禁止路径、命令、工具和证明状态；对象 key 只由
 * Server executionId 决定，错误不得暴露 Provider、数据库或存储内部详情。
 */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { stableStringifyJcsV1 } from "../../common/utils/canonical.js";
import type { StructuredModelRequest } from "../openai/openai.contracts.js";
import {
  professionEngineerModelDecisionSchema,
  type ProfessionEngineerModelDecision,
} from "./profession-engineer-plan.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import type { ReserveProfessionModelExecutionResult } from "./profession-model-execution.js";

/** Engineer plan Artifact 固定媒体类型；对象存储声明和数据库 Artifact 必须一致。 */
export const engineerPlanMediaType = "application/json" as const;
const engineerSchemaName = "profession_engineer_pixel_style_decision_v1";

/**
 * 构造固定 engineer structured 请求；Worker、HTTP 或模型配置不能覆盖 schema、role 或指令。
 * @param context Repository 从冻结 Job payload 解析并复核哈希后的单技能上下文。
 * @returns 只含受限视觉需求的结构化模型请求，不含路径、工具、用户密钥或部署授权。
 */
export function createEngineerModelRequest(
  context: FrozenProfessionSkillExecutionContext,
): StructuredModelRequest<ProfessionEngineerModelDecision> {
  return {
    runId: context.runId,
    role: "engineer",
    schemaName: engineerSchemaName,
    schema: professionEngineerModelDecisionSchema,
    instructions: [
      "Return only the bounded pixel-style decision required by the schema.",
      "Choose RGB palette bytes, bounded intensity parameters, and optional visual operations only.",
      "Do not emit paths, commands, code, tools, resource mappings, geometry or alpha changes, coverage claims, or deployment instructions.",
    ].join(" "),
    input: stableStringifyJcsV1({
      schemaVersion: 1,
      professionId: context.professionId,
      styleId: context.styleId,
      skillId: context.skill.skillId,
      themeDefinition: context.themeDefinition,
      professionPrompt: context.skill.professionPrompt,
      skillThemePrompt: context.skill.skillThemePrompt,
      sourceEvidence: context.skill.sourceEvidence,
    }),
  };
}

/** @returns Server execution UUID 派生的私有 JSON 对象 key；调用方不能选择目录或文件名。 */
export function engineerPlanObjectKey(executionId: string): string {
  return `artifacts/profession-${executionId}-engineer-plan.json`;
}

/**
 * 复核对象存储返回的证据仍绑定当前 Engineer execution 和 canonical plan。
 * @throws Error 任一字段漂移时抛出内部不变量错误，上层统一映射为脱敏持久化异常。
 */
export function assertStoredPlanEvidence(
  evidence: {
    objectKey: string;
    mediaType: string;
    byteLength: number;
    sha256: string;
  },
  executionId: string,
  byteLength: number,
  sha256: string,
): void {
  if (
    evidence.objectKey !== engineerPlanObjectKey(executionId) ||
    evidence.mediaType !== engineerPlanMediaType ||
    evidence.byteLength !== byteLength ||
    evidence.sha256.toUpperCase() !== sha256.toUpperCase()
  ) {
    throw new Error("PROFESSION_ENGINEER_PLAN_EVIDENCE_MISMATCH");
  }
}

/** 将 reservation 的有限失败状态映射为稳定业务异常；不会允许调用方绕过到 Artist。 */
export function throwEngineerReservationFailure(
  result: Exclude<
    ReserveProfessionModelExecutionResult,
    | { status: "execute" }
    | { status: "passed" }
    | { status: "in-progress" }
    | { status: "persistence-pending" }
  >,
): never {
  if (result.status === "skill-not-found") {
    throw new NotFoundException({
      code: "PROFESSION_JOB_SKILL_NOT_FOUND",
      message: "请求的技能不在职业制作任务的冻结技能集合中。",
    });
  }
  if (result.status === "failed" || result.status === "indeterminate") {
    throw new ConflictException({
      code:
        result.status === "failed"
          ? "PROFESSION_ENGINEER_EXECUTION_FAILED"
          : "PROFESSION_ENGINEER_EXECUTION_INDETERMINATE",
      message: "该轮次的 Engineer 步骤已终结，禁止重复模型出站。",
    });
  }
  throw new ConflictException({
    code:
      result.status === "lease-mismatch"
        ? "JOB_LEASE_MISMATCH"
        : result.status === "job-kind-mismatch"
          ? "PATCH_TASK_JOB_KIND_REQUIRED"
          : result.status === "job-integrity-failed"
            ? "PROFESSION_JOB_INTEGRITY_FAILED"
            : "PROFESSION_ENGINEER_EXECUTION_INTEGRITY_FAILED",
    message: "当前任务状态不允许执行固定 Engineer 步骤。",
  });
}

/** @throws ConflictException 当 stage/lease/状态转换不再匹配当前事务预期。 */
export function throwEngineerStateConflict(): never {
  throw new ConflictException({
    code: "PROFESSION_ENGINEER_EXECUTION_STATE_CONFLICT",
    message: "固定 Engineer 步骤的持久化状态发生冲突。",
  });
}

/** @throws ServiceUnavailableException 当私有 canonical plan 字节尚无法完整确认。 */
export function throwEngineerPersistenceUnavailable(): never {
  throw new ServiceUnavailableException({
    code: "PROFESSION_ENGINEER_PLAN_PERSISTENCE_UNAVAILABLE",
    message: "Engineer 像素计划尚未能在私有对象存储中确认。",
  });
}
