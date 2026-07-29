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
  mapPatchTaskProgress,
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

/** 纯映射函数的完整输入；所有集合都已由 Repository 限定为同一 Run。 */
export interface BuildPatchTaskDetailInput {
  task: PatchTaskDetailBase;
  skills: PatchTaskDetailSkillRecord[];
  executions: PatchTaskDetailExecutionRecord[];
  modelCalls: PatchTaskDetailModelCallRecord[];
}

/**
 * 生成浏览器任务详情并保守处理缺失证据。
 * @param input 同一用户、同一 Run 的主记录、技能、模型执行和调用投影。
 * @returns 不含内部标识与短期 URL 的详情 ViewModel；unknown/NULL 均保留真实不确定性。
 */
export function buildPatchTaskDetail(
  input: BuildPatchTaskDetailInput,
): PatchTaskDetailView {
  const skills = [...input.skills]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((skill) => mapSkill(skill, input.executions));
  const passedSkills = skills.filter(
    (skill) => skill.status === "passed",
  ).length;
  const status = mapPatchTaskStatus(
    input.task.runStatus,
    input.task.packageStatus,
  );
  const packageStatus = normalizePackageStatus(input.task.packageStatus);
  const currentStage = resolveCurrentStage(status, packageStatus, skills);
  return {
    id: input.task.id,
    professionName: input.task.professionName,
    styleName: input.task.styleName,
    status,
    progress: mapPatchTaskProgress(
      skills.length,
      passedSkills,
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
    workflow: workflow(status, packageStatus, skills),
    skills,
    packageStatus,
    modelThroughput: aggregateModelThroughput(input.modelCalls),
  };
}

/** 按当前 attempt 把固定模型证据和 Worker 生产状态组合为四阶段技能视图。 */
function mapSkill(
  skill: PatchTaskDetailSkillRecord,
  executions: PatchTaskDetailExecutionRecord[],
): PatchTaskSkillProgressView {
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
): PatchTaskWorkflowStageView[] {
  const skillStatus = aggregateSkillStatus(skills);
  return [
    {
      key: "planning",
      status:
        status === "queued"
          ? "running"
          : status === "blocked" && skillStatus === "blocked"
            ? "blocked"
            : "passed",
    },
    { key: "skill-production", status: skillStatus },
    { key: "package-validation", status: packageStepStatus(packageStatus) },
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
): PatchTaskStepStatus {
  if (status === "queued") return "pending";
  if (status === "building") return "running";
  return status;
}

function resolveCurrentStage(
  status: PatchTaskDetailView["status"],
  packageStatus: PatchTaskDetailView["packageStatus"],
  skills: PatchTaskSkillProgressView[],
): PatchTaskWorkflowStageKey {
  if (status === "passed") return "complete";
  if (["building", "failed", "blocked"].includes(packageStatus)) {
    return "package-validation";
  }
  if (
    status === "queued" &&
    skills.every((skill) => skill.status === "pending")
  ) {
    return "planning";
  }
  return "skill-production";
}
