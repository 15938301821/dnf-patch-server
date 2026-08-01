/**
 * @fileoverview 将制作任务数据库投影映射为浏览器详情、逐技能阶段和模型吞吐；不访问数据库、
 * 对象存储或 Worker，也不根据错误码、技能名或缺失证据猜测执行阶段。
 * @module modules/job/patch-task-detail
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 调用关系：PatchTask 详情 Repository 先完成用户所有权查询，再把有限数据库投影交给本文件；
 * Controller 最终只返回这里生成的脱敏 ViewModel。输入不含 Prompt、对象 key、租约或模型凭据。
 * 输出只描述可审计状态与计量，副作用为无。安全边界：Provider usage 缺失时必须保持 NULL，
 * 历史失败无法定位子步骤时必须保持 unknown，不能为了界面完整而伪造 Token 或阶段。
 */
import type {
  PatchTaskDetailView,
  PatchTaskSkillProgressView,
  PatchTaskStepStatus,
  PatchTaskWorkflowStageKey,
  PatchTaskWorkflowStageView,
} from "./patch-task.contracts.js";
import {
  mapPatchTaskEvidenceProgress,
  mapPatchTaskStatus,
} from "./patch-task-status.js";
import {
  aggregateModelThroughput,
  type PatchTaskDetailModelCallRecord,
} from "./patch-task-model-throughput.js";
import {
  professionEngineerPlanStage,
  readableProfessionReferenceImageStages,
} from "./profession-model-execution.js";

/** Repository 传入的任务主记录投影；owner 已在查询条件中验证，不在 ViewModel 中回显。 */
export interface PatchTaskDetailBase {
  id: string;
  professionName: string;
  styleName: string;
  runStatus: string;
  packageStatus: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  artifactName: string | null;
  packageArtifactId: string | null;
}

/** Repository 传入的有序技能生产投影。 */
export interface PatchTaskDetailSkillRecord {
  skillId: string;
  displayName: string;
  ordinal: number;
  status: string;
  attempt: number | null;
  errorCode: string | null;
}

/** 当前或历史 attempt 的固定模型阶段投影；映射时只消费技能当前 attempt。 */
export interface PatchTaskDetailExecutionRecord {
  skillId: string;
  attempt: number;
  stage: string;
  status: string;
  outputArtifactId: string | null;
  outputMediaType: string | null;
}

/** 当前 Run 一个 Job 的聚合状态与当前 attempt 错误；attempt 为 0 表示从未被 Worker 领取。 */
export interface PatchTaskDetailJobRecord {
  kind: string;
  status: string;
  attempt: number;
  errorCode: string | null;
}

/** 当前 Profession attempt 按技能聚合的 V6 帧证据；只包含计数，不暴露帧或 Artifact 身份。 */
export interface PatchTaskDetailTargetFrameRecord {
  skillId: string;
  attempt: number;
  targetFrameCount: number;
  generationFrameCount: number;
  sourceFrameCount: number;
}

/** 纯映射函数的完整输入；所有集合都已由 Repository 限定为同一 Run。 */
export interface BuildPatchTaskDetailInput {
  task: PatchTaskDetailBase;
  skills: PatchTaskDetailSkillRecord[];
  executions: PatchTaskDetailExecutionRecord[];
  modelCalls: PatchTaskDetailModelCallRecord[];
  /** 旧单元测试与异常历史可省略；缺失时保持原有保守映射，不能推断 Job 已执行。 */
  jobs?: PatchTaskDetailJobRecord[];
  /** 仅 V6 当前 attempt 有记录；空集合继续采用 V1-V5 映射。 */
  targetFrames?: PatchTaskDetailTargetFrameRecord[];
}

/**
 * 生成浏览器任务详情并保守处理缺失证据。
 * @param input 同一用户、同一 Run 的主记录、技能、模型执行和调用投影。
 * @returns 不含内部标识与短期 URL 的详情 ViewModel；unknown/NULL 均保留真实不确定性。
 */
export function buildPatchTaskDetail(
  input: BuildPatchTaskDetailInput,
): PatchTaskDetailView {
  const professionJob = input.jobs?.find((job) => job.kind === "profession");
  const packageJob = input.jobs?.find((job) => job.kind === "npk-package");
  const skills = [...input.skills]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((skill) =>
      mapSkill(
        skill,
        input.executions,
        professionJob,
        input.targetFrames ?? [],
      ),
    );
  const passedSkills = skills.filter(
    (skill) => skill.status === "passed",
  ).length;
  const status = mapPatchTaskStatus(
    input.task.runStatus,
    input.task.packageStatus,
  );
  const packageStatus = normalizePackageStatus(input.task.packageStatus);
  const currentStage = resolveCurrentStage(
    status,
    packageStatus,
    skills,
    professionJob,
    packageJob,
  );
  return {
    id: input.task.id,
    professionName: input.task.professionName,
    styleName: input.task.styleName,
    status,
    progress: mapPatchTaskEvidenceProgress(
      skills,
      input.task.runStatus,
      input.task.packageStatus,
    ),
    createdAt: input.task.createdAt.toISOString(),
    updatedAt: input.task.updatedAt.toISOString(),
    ...(input.task.finishedAt
      ? { finishedAt: input.task.finishedAt.toISOString() }
      : {}),
    ...(input.task.artifactName
      ? { artifactName: input.task.artifactName }
      : {}),
    artifactAvailable: input.task.packageArtifactId !== null,
    currentStage,
    totalSkills: skills.length,
    passedSkills,
    workflow: workflow(
      status,
      packageStatus,
      skills,
      professionJob,
      packageJob,
    ),
    skills,
    packageStatus,
    modelThroughput: aggregateModelThroughput(input.modelCalls),
  };
}

/** 按当前 attempt 把固定模型证据和 Worker 生产状态组合为四阶段技能视图。 */
function mapSkill(
  skill: PatchTaskDetailSkillRecord,
  executions: PatchTaskDetailExecutionRecord[],
  professionJob: PatchTaskDetailJobRecord | undefined,
  targetFrames: PatchTaskDetailTargetFrameRecord[],
): PatchTaskSkillProgressView {
  const targetFrame = targetFrames.find(
    (candidate) =>
      candidate.skillId === skill.skillId &&
      candidate.attempt === professionJob?.attempt,
  );
  if (targetFrame && professionJob) {
    return mapTargetFrameSkill(skill, professionJob, targetFrame);
  }
  const current = executions.filter(
    (execution) =>
      execution.skillId === skill.skillId &&
      execution.attempt === skill.attempt,
  );
  const engineer = findVersionedExecution(current, [
    professionEngineerPlanStage,
    "engineer-plan-v2",
    "engineer-plan-v1",
  ]);
  const reference = findVersionedExecution(
    current,
    readableProfessionReferenceImageStages,
  );
  const terminalWithoutPreciseStage =
    skill.status === "failed" || skill.status === "blocked";
  const engineerStatus = modelStageStatus(
    engineer,
    skill.status === "generating"
      ? "running"
      : fallbackModelStatus(skill.status),
  );
  const referenceStatus = modelStageStatus(
    reference,
    skill.status === "generating" && engineerStatus === "passed"
      ? "running"
      : fallbackModelStatus(skill.status),
  );
  return {
    skillId: skill.skillId,
    displayName: skill.displayName,
    status: productionStatus(skill.status),
    stages: [
      { key: "engineer-plan", status: engineerStatus },
      { key: "reference-image", status: referenceStatus },
      {
        key: "aseprite-adaptation",
        status: terminalWithoutPreciseStage
          ? "unknown"
          : toolStageStatus(skill.status, "adaptation"),
      },
      {
        key: "runtime-validation",
        status: terminalWithoutPreciseStage
          ? "unknown"
          : toolStageStatus(skill.status, "validation"),
      },
    ],
    ...(skill.errorCode ? { errorCode: skill.errorCode } : {}),
    referenceImageAvailable:
      reference?.status === "passed" &&
      reference.outputArtifactId !== null &&
      reference.outputMediaType === "image/png",
  };
}

/**
 * 将当前 Profession attempt 的 V6 逐帧证据映射为用户可读阶段。
 * target 表存在证明 manifest 已经由 Server 复读并原子登记；只有全部生成帧都有 source PNG 时，
 * 才允许把源帧冻结标记为通过。Job 终态只落到证据链中第一个尚未通过的阶段。
 */
function mapTargetFrameSkill(
  skill: PatchTaskDetailSkillRecord,
  professionJob: PatchTaskDetailJobRecord,
  targetFrame: PatchTaskDetailTargetFrameRecord,
): PatchTaskSkillProgressView {
  const sourceFramesReady =
    targetFrame.sourceFrameCount === targetFrame.generationFrameCount;
  const activeStatus = jobStepStatus(professionJob.status);
  const sourceStatus = sourceFramesReady ? "passed" : activeStatus;
  const generationStatus = sourceFramesReady ? activeStatus : "pending";
  return {
    skillId: skill.skillId,
    displayName: skill.displayName,
    status: activeStatus,
    stages: [
      { key: "target-manifest", status: "passed" },
      { key: "source-frame-freeze", status: sourceStatus },
      { key: "target-frame-generation", status: generationStatus },
      {
        key: "runtime-validation",
        status: professionJob.status === "passed" ? "passed" : "pending",
      },
    ],
    ...(professionJob.errorCode ? { errorCode: professionJob.errorCode } : {}),
    referenceImageAvailable: false,
    framePreparation: {
      targetFrameCount: targetFrame.targetFrameCount,
      generationFrameCount: targetFrame.generationFrameCount,
      sourceFrameCount: targetFrame.sourceFrameCount,
    },
  };
}

/** 把 Profession Job 状态映射到当前尚未通过的 V6 阶段；未知值保持 unknown。 */
function jobStepStatus(status: string): PatchTaskStepStatus {
  if (status === "queued") return "pending";
  if (status === "leased") return "running";
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  return "unknown";
}

/** 按新到旧选择同一逻辑阶段，避免数据库返回顺序让历史记录遮蔽当前 V3 证据。 */
function findVersionedExecution(
  executions: readonly PatchTaskDetailExecutionRecord[],
  stages: readonly string[],
): PatchTaskDetailExecutionRecord | undefined {
  for (const stage of stages) {
    const execution = executions.find((candidate) => candidate.stage === stage);
    if (execution) return execution;
  }
  return undefined;
}

function fallbackModelStatus(production: string): PatchTaskStepStatus {
  if (production === "planned") return "pending";
  if (production === "passed") return "unknown";
  if (production === "adapting" || production === "validating")
    return "unknown";
  if (production === "failed" || production === "blocked") return "unknown";
  return "pending";
}

function modelStageStatus(
  execution: PatchTaskDetailExecutionRecord | undefined,
  fallback: PatchTaskStepStatus,
): PatchTaskStepStatus {
  if (!execution) return fallback;
  if (["prepared", "egressing", "persisting"].includes(execution.status)) {
    return "running";
  }
  if (execution.status === "passed") return "passed";
  if (["failed", "indeterminate"].includes(execution.status)) return "failed";
  return "unknown";
}

function productionStatus(status: string): PatchTaskStepStatus {
  if (status === "planned") return "pending";
  if (["generating", "adapting", "validating"].includes(status)) {
    return "running";
  }
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  return "unknown";
}

function toolStageStatus(
  production: string,
  stage: "adaptation" | "validation",
): PatchTaskStepStatus {
  if (production === "passed") return "passed";
  if (stage === "adaptation") {
    if (production === "adapting") return "running";
    if (production === "validating") return "passed";
  }
  if (stage === "validation" && production === "validating") return "running";
  return "pending";
}

function normalizePackageStatus(
  status: string,
): PatchTaskDetailView["packageStatus"] {
  return ["queued", "building", "passed", "failed", "blocked"].includes(status)
    ? (status as PatchTaskDetailView["packageStatus"])
    : "blocked";
}

function aggregateSkillStatus(
  skills: PatchTaskSkillProgressView[],
): PatchTaskStepStatus {
  if (skills.some((skill) => skill.status === "failed")) return "failed";
  if (skills.some((skill) => skill.status === "blocked")) return "blocked";
  if (skills.length > 0 && skills.every((skill) => skill.status === "passed")) {
    return "passed";
  }
  if (skills.some((skill) => skill.status === "running")) return "running";
  return "pending";
}

function workflow(
  status: PatchTaskDetailView["status"],
  packageStatus: PatchTaskDetailView["packageStatus"],
  skills: PatchTaskSkillProgressView[],
  professionJob: PatchTaskDetailJobRecord | undefined,
  packageJob: PatchTaskDetailJobRecord | undefined,
): PatchTaskWorkflowStageView[] {
  const skillStatus = aggregateSkillStatus(skills);
  return [
    {
      key: "planning",
      status:
        status === "queued"
          ? "running"
          : status === "blocked" &&
              skillStatus === "blocked" &&
              (professionJob?.attempt ?? 0) === 0
            ? "blocked"
            : "passed",
    },
    { key: "skill-production", status: skillStatus },
    {
      key: "package-validation",
      status: packageStepStatus(packageStatus, packageJob),
    },
    {
      key: "complete",
      status:
        status === "passed"
          ? "passed"
          : status === "failed"
            ? "failed"
            : status === "blocked"
              ? "blocked"
              : "pending",
    },
  ];
}

function packageStepStatus(
  status: PatchTaskDetailView["packageStatus"],
  packageJob: PatchTaskDetailJobRecord | undefined,
): PatchTaskStepStatus {
  // 上游失败会把未领取的 Package 联动为 blocked；attempt=0 必须显示“等待”，不能伪装成封包失败。
  if (packageJob?.attempt === 0) return "pending";
  if (status === "queued") return "pending";
  if (status === "building") return "running";
  return status;
}

function resolveCurrentStage(
  status: PatchTaskDetailView["status"],
  packageStatus: PatchTaskDetailView["packageStatus"],
  skills: PatchTaskSkillProgressView[],
  professionJob: PatchTaskDetailJobRecord | undefined,
  packageJob: PatchTaskDetailJobRecord | undefined,
): PatchTaskWorkflowStageKey {
  if (status === "passed") return "complete";
  if (
    ["building", "failed", "blocked"].includes(packageStatus) &&
    packageJob?.attempt !== 0
  ) {
    return "package-validation";
  }
  if (
    status === "blocked" &&
    aggregateSkillStatus(skills) === "blocked" &&
    (professionJob?.attempt ?? 0) === 0
  ) {
    return "planning";
  }
  if (
    status === "queued" &&
    skills.every((skill) => skill.status === "pending")
  ) {
    return "planning";
  }
  return "skill-production";
}
