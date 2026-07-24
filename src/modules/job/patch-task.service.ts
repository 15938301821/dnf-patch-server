/**
 * @fileoverview 将前端制作任务请求映射为受 Guardrail 保护的 Run 与固定 Worker Job。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import { FactoryService } from "../factory/factory.service.js";
import { ProfessionService } from "../profession/profession.service.js";
import { ProjectService } from "../project/project.service.js";
import { RunService } from "../run/run.service.js";
import { WorkerService } from "../worker/worker.service.js";
import type { CreateRunInput, RunCreateOptions } from "../run/run.contracts.js";
import type {
  CreatePatchTaskInput,
  PatchTaskArtifactView,
  PatchTaskReportResult,
  PatchTaskView,
  PlannedPatchTaskSkill,
  ReportPatchTaskPackageInput,
  ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import { PatchTaskRepository } from "./patch-task.repository.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import type {
  FrozenProfessionSkillExecutionContext,
  ResolveProfessionExecutionContextResult,
} from "./profession-execution-context.js";
import {
  createStyleSkillProductionJobPayload,
  type StyleSkillProductionJobPayloadV2,
} from "./style-skill-production.contracts.js";
import type {
  ProfessionProductionProgressInput,
  ProfessionProductionProgressView,
} from "./profession-production-progress.contracts.js";

interface PatchTaskRepositoryPort {
  list(ownerUserId: string): Promise<PatchTaskView[]>;
  createPlan(
    pack: Parameters<PatchTaskRepository["createPlan"]>[0],
    skills: PlannedPatchTaskSkill[],
    disposition: "dispatch" | "blocked",
  ): Promise<void>;
  findArtifact(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView | undefined>;
  reportSkillProduction(
    jobId: string,
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<PatchTaskReportResult>;
  reportPackage(
    jobId: string,
    input: ReportPatchTaskPackageInput,
  ): Promise<PatchTaskReportResult>;
  resolveProfessionSkillExecution(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ResolveProfessionExecutionContextResult>;
  resolveProfessionProductionProgress(
    jobId: string,
    input: ProfessionProductionProgressInput,
  ): Promise<
    | { status: "accepted"; progress: ProfessionProductionProgressView }
    | {
        status:
          | "lease-mismatch"
          | "job-kind-mismatch"
          | "job-integrity-failed"
          | "production-integrity-failed";
      }
  >;
}

interface ProfessionBuildContextPort {
  getStyleBuildContext(
    professionId: string,
    styleId: string,
    ownerUserId: string,
  ): ReturnType<ProfessionService["getStyleBuildContext"]>;
}

interface FactoryLookupPort {
  get(id: string): ReturnType<FactoryService["get"]>;
}

interface ProjectLookupPort {
  get(id: string): ReturnType<ProjectService["get"]>;
}

interface RunCreatePort {
  create(
    input: CreateRunInput,
    idempotencyKey: string,
    options?: RunCreateOptions,
  ): ReturnType<RunService["create"]>;
  blockDeferredDispatch(
    runId: string,
  ): ReturnType<RunService["blockDeferredDispatch"]>;
}

interface ProfessionWorkerCapabilityPort {
  hasEnabledCapability(
    capability: "profession",
  ): ReturnType<WorkerService["hasEnabledCapability"]>;
}

@Injectable()
export class PatchTaskService {
  constructor(
    @Inject(PatchTaskRepository)
    private readonly patchTasks: PatchTaskRepositoryPort,
    @Inject(ProfessionService)
    private readonly professions: ProfessionBuildContextPort,
    @Inject(FactoryService) private readonly factories: FactoryLookupPort,
    @Inject(ProjectService) private readonly projects: ProjectLookupPort,
    @Inject(RunService) private readonly runs: RunCreatePort,
    @Inject(WorkerService)
    private readonly workers: ProfessionWorkerCapabilityPort,
  ) {}

  list(ownerUserId: string): Promise<PatchTaskView[]> {
    return this.patchTasks.list(ownerUserId);
  }

  async create(
    input: CreatePatchTaskInput,
    idempotencyKey: string,
    ownerUserId: string,
  ): Promise<PatchTaskView> {
    const context = await this.professions.getStyleBuildContext(
      input.professionId,
      input.styleId,
      ownerUserId,
    );
    if (!context.profession.workflowProjectId) {
      throw new ConflictException({
        code: "PROFESSION_WORKFLOW_PROJECT_REQUIRED",
        message: "职业尚未绑定已核验资源项目，不能创建制作任务。",
      });
    }
    const project = await this.projects.get(
      context.profession.workflowProjectId,
    );
    const factory = await this.factories.get(project.factoryId);
    if (factory.config.schemaVersion !== 2) {
      throw new ConflictException({
        code: "FACTORY_POLICY_VERSION_REQUIRED",
        message: "制作任务需要使用 Factory v2 工作流。",
      });
    }
    if (!(await this.workers.hasEnabledCapability("profession"))) {
      throw new ConflictException({
        code: "PROFESSION_WORKER_REQUIRED",
        message: "尚无启用的 Worker 声明职业制作能力。",
      });
    }
    let payload: StyleSkillProductionJobPayloadV2;
    try {
      payload = createStyleSkillProductionJobPayload(
        context,
        factory.config.profileId,
      );
    } catch {
      throw new ConflictException({
        code: "STYLE_JOB_PAYLOAD_INVALID",
        message: "主题冻结包不符合内容绑定或声明式任务预算。",
      });
    }
    const runInput = createRunInput(
      context,
      factory.config,
      idempotencyKey,
      payload,
    );
    const run = await this.runs.create(runInput, idempotencyKey, {
      deferJobDispatch: true,
      ownerUserId,
    });
    try {
      await this.patchTasks.createPlan(
        {
          id: randomUUID(),
          professionId: context.profession.id,
          styleId: context.style.id,
          runId: run.id,
        },
        payload.parameters.promptPackage.skills.map(
          (skill): PlannedPatchTaskSkill => ({
            professionId: context.profession.id,
            styleId: context.style.id,
            skillId: skill.skillId,
            sourceRunId: skill.sourceEvidence.sourceRunId,
            sourceFrameManifestArtifactId:
              skill.sourceEvidence.sourceFrameManifestArtifactId,
            promptSha256: skill.promptSha256,
          }),
        ),
        run.status === "blocked" ? "blocked" : "dispatch",
      );
    } catch {
      try {
        await this.runs.blockDeferredDispatch(run.id);
      } catch {
        throw new ServiceUnavailableException({
          code: "PATCH_TASK_PLAN_COMPENSATION_FAILED",
          message:
            "制作任务计划失败，且安全补偿未能确认，请稍后查询 Run 状态。",
          runId: run.id,
        });
      }
      throw new ServiceUnavailableException({
        code: "PATCH_TASK_PLAN_FAILED",
        message: "制作任务计划未能完整建立，Run 已安全阻断。",
        runId: run.id,
      });
    }
    return {
      id: run.id,
      professionName: context.profession.name,
      styleName: context.style.name,
      status: run.status === "blocked" ? "blocked" : "queued",
      progress: 0,
      createdAt: run.createdAtUtc,
      artifactAvailable: false,
    };
  }

  async findArtifact(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView> {
    const artifact = await this.patchTasks.findArtifact(runId, ownerUserId);
    if (!artifact) {
      throw new NotFoundException({
        code: "PATCH_TASK_ARTIFACT_NOT_READY",
        message: "制作任务产物尚未生成或未通过验证。",
      });
    }
    return artifact;
  }

  async reportSkillProduction(
    jobId: string,
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<void> {
    assertReportAccepted(
      await this.patchTasks.reportSkillProduction(jobId, input),
    );
  }

  async reportPackage(
    jobId: string,
    input: ReportPatchTaskPackageInput,
  ): Promise<void> {
    assertReportAccepted(await this.patchTasks.reportPackage(jobId, input));
  }

  async resolveProfessionSkillExecution(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<FrozenProfessionSkillExecutionContext> {
    const result = await this.patchTasks.resolveProfessionSkillExecution(
      jobId,
      input,
    );
    if (result.status === "accepted") return result.context;
    const definition = professionExecutionFailureDefinitions[result.status];
    if (definition.kind === "not-found") {
      throw new NotFoundException({
        code: definition.code,
        message: definition.message,
      });
    }
    throw new ConflictException({
      code: definition.code,
      message: definition.message,
    });
  }

  /** 读取当前 lease 的冻结多技能进度；完整性失败统一映射为不泄露数据库细节的冲突。 */
  async resolveProfessionProductionProgress(
    jobId: string,
    input: ProfessionProductionProgressInput,
  ): Promise<ProfessionProductionProgressView> {
    const result = await this.patchTasks.resolveProfessionProductionProgress(
      jobId,
      input,
    );
    if (result.status === "accepted") return result.progress;
    const definition = professionProgressFailureDefinitions[result.status];
    throw new ConflictException({
      code: definition.code,
      message: definition.message,
    });
  }
}

const professionProgressFailureDefinitions = {
  "lease-mismatch": {
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    code: "PATCH_TASK_JOB_KIND_REQUIRED",
    message: "只有 profession 类型任务可以读取职业生产进度。",
  },
  "job-integrity-failed": {
    code: "PROFESSION_JOB_INTEGRITY_FAILED",
    message: "职业制作任务的冻结内容完整性校验失败。",
  },
  "production-integrity-failed": {
    code: "PROFESSION_PRODUCTION_EVIDENCE_MISMATCH",
    message: "职业技能生产证据与冻结任务不一致。",
  },
} as const;

const professionExecutionFailureDefinitions: Record<
  Exclude<ResolveProfessionExecutionContextResult["status"], "accepted">,
  { kind: "conflict" | "not-found"; code: string; message: string }
> = {
  "lease-mismatch": {
    kind: "conflict",
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    kind: "conflict",
    code: "PATCH_TASK_JOB_KIND_REQUIRED",
    message: "只有 profession 类型任务可以请求固定技能生产步骤。",
  },
  "job-integrity-failed": {
    kind: "conflict",
    code: "PROFESSION_JOB_INTEGRITY_FAILED",
    message: "职业制作任务的冻结内容完整性校验失败。",
  },
  "skill-not-found": {
    kind: "not-found",
    code: "PROFESSION_JOB_SKILL_NOT_FOUND",
    message: "请求的技能不在职业制作任务的冻结技能集合中。",
  },
};

function assertReportAccepted(result: PatchTaskReportResult): void {
  if (result.status === "accepted") return;
  const definition = reportFailureDefinitions[result.status];
  if (definition.kind === "not-found") {
    throw new NotFoundException({
      code: definition.code,
      message: definition.message,
    });
  }
  throw new ConflictException({
    code: definition.code,
    message: definition.message,
  });
}

const reportFailureDefinitions: Record<
  Exclude<PatchTaskReportResult["status"], "accepted">,
  { kind: "conflict" | "not-found"; code: string; message: string }
> = {
  "lease-mismatch": {
    kind: "conflict",
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    kind: "conflict",
    code: "PATCH_TASK_JOB_KIND_REQUIRED",
    message: "只有 profession 类型任务可以回填主题技能生产证据。",
  },
  "skill-production-not-found": {
    kind: "not-found",
    code: "STYLE_SKILL_PRODUCTION_NOT_FOUND",
    message: "主题技能生产记录不存在。",
  },
  "skill-production-terminal": {
    kind: "conflict",
    code: "STYLE_SKILL_PRODUCTION_TERMINAL",
    message: "主题技能生产记录已终结，不能再次回填。",
  },
  "skill-production-evidence-mismatch": {
    kind: "conflict",
    code: "STYLE_SKILL_PRODUCTION_EVIDENCE_MISMATCH",
    message: "主题技能生产记录与当前冻结任务证据不一致。",
  },
  "model-execution-evidence-mismatch": {
    kind: "conflict",
    code: "STYLE_SKILL_MODEL_EXECUTION_EVIDENCE_MISMATCH",
    message: "当前任务轮次的固定模型执行证据不完整或不一致。",
  },
  "artifact-evidence-mismatch": {
    kind: "conflict",
    code: "STYLE_SKILL_ARTIFACT_EVIDENCE_MISMATCH",
    message: "技能输出 Artifact 未由当前任务轮次完整生成。",
  },
  "package-not-found": {
    kind: "not-found",
    code: "STYLE_PACKAGE_NOT_FOUND",
    message: "主题包记录不存在。",
  },
  "package-terminal": {
    kind: "conflict",
    code: "STYLE_PACKAGE_TERMINAL",
    message: "主题包记录已终结，不能再次回填。",
  },
  "package-capability-not-frozen": {
    kind: "conflict",
    code: "STYLE_PACKAGE_CAPABILITY_NOT_FROZEN",
    message: "当前职业制作任务未冻结最终封包工具与验证契约。",
  },
};

type FactoryV2Config = Extract<
  Awaited<ReturnType<FactoryService["get"]>>["config"],
  { schemaVersion: 2 }
>;

function createRunInput(
  context: Awaited<ReturnType<ProfessionService["getStyleBuildContext"]>>,
  factoryConfig: FactoryV2Config,
  idempotencyKey: string,
  payload: StyleSkillProductionJobPayloadV2,
): CreateRunInput {
  if (
    !context.profession.workflowProjectId ||
    !context.profession.catalogSnapshotId
  ) {
    throw new Error("PROFESSION_WORKFLOW_CONTEXT_MISSING");
  }
  const requestBody = {
    action: "generate-patch",
    professionId: context.profession.id,
    styleId: context.style.id,
    selectedSkillIds: context.style.selectedSkillIds,
    payload,
  };
  return {
    projectId: context.profession.workflowProjectId,
    snapshotId: context.profession.catalogSnapshotId,
    clientRunId: `patch.${sha256JcsV1({
      idempotencyKey,
      professionId: context.profession.id,
      styleId: context.style.id,
    })}`,
    action: "generate-patch",
    requestSha256: sha256JcsV1(requestBody),
    serverConnectionEnabled: true,
    modelEgressAuthorized: true,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    jobs: [{ kind: "profession", payload, maxAttempts: 3 }],
    policyId: factoryConfig.policyId,
    policySha256: factoryConfig.policySha256,
  };
}
