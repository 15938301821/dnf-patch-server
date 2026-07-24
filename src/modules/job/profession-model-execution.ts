/**
 * @fileoverview 定义并校验单技能固定模型步骤的内部幂等状态；不查询数据库、不调用模型、
 * 不访问对象存储，也不向 Worker 暴露 Prompt 或模型配置。
 * @module modules/job/profession-model-execution
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：PatchTaskRepository 锁定 Job 与执行记录后调用本文件分类既有状态；Service 只有在
 * Repository 返回 execute 时才可进入固定模型编排。输入是数据库行与冻结上下文身份，输出是有限
 * 状态。副作用：纯内存比较。
 * 安全边界：egressing 表示唯一出站权已经消费，重复请求只能观察状态；任一绑定或终态证据不完整
 * 都返回 execution-integrity-failed，绝不能降级为新的 execute。
 */
import type {
  FrozenProfessionSkillExecutionContext,
  ResolveProfessionExecutionContextResult,
} from "./profession-execution-context.js";

/** Server 内部固定的 Engineer style plan 阶段；Worker DTO 不能选择或覆盖。 */
export const professionEngineerPlanStage = "engineer-plan-v1" as const;
/** Server 内部固定的 Artist 参考图阶段；只能在 Engineer 证据通过后预留。 */
export const professionReferenceImageStage = "reference-image-v1" as const;
/** 单技能模型链唯一允许的阶段集合，不接受数据库或 Worker 自由字符串。 */
export type ProfessionModelExecutionStage =
  | typeof professionEngineerPlanStage
  | typeof professionReferenceImageStage;

export interface ProfessionModelExecutionIdentity {
  runId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  skillId: string;
  stage: ProfessionModelExecutionStage;
  promptSha256: string;
}

export interface ProfessionModelOutputEvidence {
  modelCallId: string;
  outputSha256: string;
  outputByteLength: number;
}

interface FinalizeProfessionModelArtifactInput extends ProfessionModelOutputEvidence {
  artifactId: string;
  storageKey: string;
  logicalName: string;
}

/** Engineer 计划终态只创建私有 JSON Artifact，不得伪造 ImageAttempt。 */
export interface FinalizeProfessionEngineerPlanInput extends FinalizeProfessionModelArtifactInput {
  stage: typeof professionEngineerPlanStage;
  mediaType: "application/json";
}

/** Artist 参考图终态必须原子创建 PNG Artifact 与不可直接运行的 ImageAttempt。 */
export interface FinalizeProfessionReferenceImageInput extends FinalizeProfessionModelArtifactInput {
  stage: typeof professionReferenceImageStage;
  imageAttemptId: string;
  mediaType: "image/png";
  inputSnapshotSha256: string;
  generationConfigSha256: string;
  adapterIdentity: string;
}

/** Repository 依据固定 stage 区分两种终态证据，未知组合无法通过 TypeScript 或数据库 CHECK。 */
export type FinalizeProfessionModelOutputInput =
  | FinalizeProfessionEngineerPlanInput
  | FinalizeProfessionReferenceImageInput;

export interface PersistedProfessionModelExecution extends Omit<
  ProfessionModelExecutionIdentity,
  "stage"
> {
  id: string;
  /** 数据库读取值在分类前不可信，未知 stage 必须返回 execution-integrity-failed。 */
  stage: string;
  status: string;
  modelCallId: string | null;
  imageAttemptId: string | null;
  outputArtifactId: string | null;
  outputSha256: string | null;
  outputByteLength: number | null;
  errorCode: string | null;
}

export type ExistingProfessionModelExecutionResult =
  | { status: "acquire"; executionId: string }
  | { status: "in-progress"; executionId: string }
  | {
      status: "persistence-pending";
      executionId: string;
      modelCallId: string;
      outputSha256: string;
      outputByteLength: number;
    }
  | {
      status: "passed";
      stage: typeof professionEngineerPlanStage;
      executionId: string;
      modelCallId: string;
      outputArtifactId: string;
      outputSha256: string;
      outputByteLength: number;
    }
  | {
      status: "passed";
      stage: typeof professionReferenceImageStage;
      executionId: string;
      modelCallId: string;
      imageAttemptId: string;
      outputArtifactId: string;
      outputSha256: string;
      outputByteLength: number;
    }
  | {
      status: "failed" | "indeterminate";
      executionId: string;
      errorCode: string;
    }
  | { status: "execution-integrity-failed" };

type ProfessionExecutionGateFailure = Exclude<
  ResolveProfessionExecutionContextResult,
  { status: "accepted" }
>;

export type ReserveProfessionModelExecutionResult =
  | ProfessionExecutionGateFailure
  | { status: "prerequisite-not-passed" }
  | Exclude<
      ExistingProfessionModelExecutionResult,
      { status: "acquire" } | { status: "persistence-pending" }
    >
  | (Extract<
      ExistingProfessionModelExecutionResult,
      { status: "persistence-pending" }
    > & { context: FrozenProfessionSkillExecutionContext })
  | {
      status: "execute";
      executionId: string;
      context: FrozenProfessionSkillExecutionContext;
    };

export function classifyProfessionModelExecution(
  execution: PersistedProfessionModelExecution,
  expected: ProfessionModelExecutionIdentity,
): ExistingProfessionModelExecutionResult {
  if (
    execution.runId !== expected.runId ||
    execution.jobId !== expected.jobId ||
    execution.workerId !== expected.workerId ||
    execution.leaseId !== expected.leaseId ||
    execution.attempt !== expected.attempt ||
    execution.skillId !== expected.skillId ||
    execution.stage !== expected.stage ||
    execution.promptSha256.toUpperCase() !== expected.promptSha256.toUpperCase()
  ) {
    return { status: "execution-integrity-failed" };
  }
  if (execution.status === "prepared") {
    return { status: "acquire", executionId: execution.id };
  }
  if (execution.status === "egressing") {
    return { status: "in-progress", executionId: execution.id };
  }
  if (execution.status === "persisting") {
    if (
      !execution.modelCallId ||
      !execution.outputSha256 ||
      execution.outputByteLength === null ||
      execution.outputByteLength <= 0
    ) {
      return { status: "execution-integrity-failed" };
    }
    return {
      status: "persistence-pending",
      executionId: execution.id,
      modelCallId: execution.modelCallId,
      outputSha256: execution.outputSha256.toUpperCase(),
      outputByteLength: execution.outputByteLength,
    };
  }
  if (execution.status === "passed") {
    if (
      !execution.modelCallId ||
      !execution.outputArtifactId ||
      !execution.outputSha256 ||
      execution.outputByteLength === null ||
      execution.outputByteLength <= 0
    ) {
      return { status: "execution-integrity-failed" };
    }
    const evidence = {
      status: "passed" as const,
      executionId: execution.id,
      modelCallId: execution.modelCallId,
      outputArtifactId: execution.outputArtifactId,
      outputSha256: execution.outputSha256.toUpperCase(),
      outputByteLength: execution.outputByteLength,
    };
    if (expected.stage === professionEngineerPlanStage) {
      return execution.imageAttemptId
        ? { status: "execution-integrity-failed" }
        : { ...evidence, stage: professionEngineerPlanStage };
    }
    return execution.imageAttemptId
      ? {
          ...evidence,
          stage: professionReferenceImageStage,
          imageAttemptId: execution.imageAttemptId,
        }
      : { status: "execution-integrity-failed" };
  }
  if (execution.status === "failed" || execution.status === "indeterminate") {
    return execution.errorCode
      ? {
          status: execution.status,
          executionId: execution.id,
          errorCode: execution.errorCode,
        }
      : { status: "execution-integrity-failed" };
  }
  return { status: "execution-integrity-failed" };
}
