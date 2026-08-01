/**
 * @fileoverview 将前端制作任务请求映射为受 Guardrail 保护的 Run 与固定 Worker Job。
 * @module job
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { ArtifactService } from "../artifact/artifact.service.js";
import { resolveFactoryJobContract } from "../factory/factory.contracts.js";
import { FactoryService } from "../factory/factory.service.js";
import { ProfessionService } from "../profession/profession.service.js";
import { ProjectService } from "../project/project.service.js";
import { RunService } from "../run/run.service.js";
import { WorkerService } from "../worker/worker.service.js";
import type {
  CreatePatchTaskInput,
  PatchTaskArtifactDownloadView,
  PatchTaskArtifactRole,
  PatchTaskArtifactView,
  PatchTaskDetailView,
  PatchTaskReferenceImageDownloadView,
  PatchTaskSkillPreviewDownloadView,
  PatchTaskSkillPreviewRole,
  PatchTaskView,
  PlannedPatchTaskSkill,
  ReportPatchTaskPackageInput,
  ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import { PatchTaskRepository } from "./patch-task.repository.js";
import type { ProfessionSkillLeaseInput } from "./profession-execution.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import {
  createStyleSkillProductionJobPayload,
  type StyleSkillProductionJobPayload,
} from "./style-skill-production.contracts.js";
import type {
  ProfessionProductionProgressInput,
  ProfessionProductionProgressView,
} from "./profession-production-progress.contracts.js";
import { type StylePackageProductionJobPayloadV3 } from "./style-package-production.contracts.js";
import {
  assertPatchTaskReportAccepted,
  createPatchTaskPackagePayload,
  createPatchTaskRunInput,
  requireProfessionExecutionContext,
  requireProfessionProgress,
  type PackageProfileConfigPort,
} from "./patch-task.service-support.js";
import {
  authorizePatchTaskReferenceImageDownload,
  authorizePatchTaskSkillPreviewDownload,
} from "./patch-task-preview-authorization.service-support.js";
import type {
  FactoryLookupPort,
  PatchTaskArtifactDownloadPort,
  PatchTaskRepositoryPort,
  PatchTaskWorkerCapabilityPort,
  ProfessionBuildContextPort,
  ProjectLookupPort,
  RunCreatePort,
} from "./patch-task.service-ports.js";

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
    private readonly workers: PatchTaskWorkerCapabilityPort,
    @Inject(ArtifactService)
    private readonly artifacts: PatchTaskArtifactDownloadPort,
    @Inject(ConfigService)
    private readonly config: PackageProfileConfigPort,
  ) {}

  list(ownerUserId: string): Promise<PatchTaskView[]> {
    return this.patchTasks.list(ownerUserId);
  }

  /**
   * 读取当前浏览器用户拥有的一项制作任务详情。
   *
   * @param runId Controller path 中已校验的 Run UUID。
   * @param ownerUserId 从浏览器 Access Token 解析的稳定用户 ID，不能来自 query/body。
   * @returns 阶段、技能与模型吞吐的脱敏 ViewModel，不包含内部租约或对象引用。
   * @throws PATCH_TASK_NOT_FOUND 当任务不存在或不属于当前用户时统一抛出，防止跨用户枚举。
   */
  async findDetail(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskDetailView> {
    const detail = await this.patchTasks.findDetail(runId, ownerUserId);
    if (!detail) {
      throw new NotFoundException({
        code: "PATCH_TASK_NOT_FOUND",
        message: "制作任务不存在或当前用户无权查看。",
      });
    }
    return detail;
  }

  /**
   * 为当前用户任务中的固定技能参考图签发短期读取授权。
   * @param runId Controller path 中已校验的任务 UUID。
   * @param skillId Controller path 中已校验的技能 UUID；浏览器不能提交 Artifact ID。
   * @param ownerUserId 从浏览器 Access Token 解析的稳定用户 ID。
   * @returns PNG 元数据与短期 URL；不证明图片已用于 runtime 像素或最终补丁。
   * @throws PATCH_TASK_REFERENCE_IMAGE_NOT_READY 当所有权、当前 attempt、固定 stage 或 PNG 证据不完整。
   */
  async authorizeReferenceImageDownload(
    runId: string,
    skillId: string,
    ownerUserId: string,
  ): Promise<PatchTaskReferenceImageDownloadView> {
    return authorizePatchTaskReferenceImageDownload(
      this.patchTasks,
      this.artifacts,
      runId,
      skillId,
      ownerUserId,
    );
  }

  /**
   * 为当前用户任务中的一个固定技能预览角色签发短期读取授权。
   * @param runId Controller path 中已校验的任务 UUID。
   * @param skillId Controller path 中已校验的技能 UUID。
   * @param role 严格枚举的源帧、模型参考图或 Aseprite 结果；不是 Artifact 名称。
   * @param ownerUserId 从浏览器 Access Token 解析的稳定用户 ID。
   * @returns PNG 脱敏元数据与短期 URL；不证明兼容、部署或全技能覆盖。
   */
  async authorizeSkillPreviewDownload(
    runId: string,
    skillId: string,
    role: PatchTaskSkillPreviewRole,
    ownerUserId: string,
  ): Promise<PatchTaskSkillPreviewDownloadView> {
    return authorizePatchTaskSkillPreviewDownload(
      this.patchTasks,
      this.artifacts,
      runId,
      skillId,
      role,
      ownerUserId,
    );
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
    if (factory.config.schemaVersion === 1) {
      throw new ConflictException({
        code: "FACTORY_POLICY_VERSION_REQUIRED",
        message: "制作任务需要使用 Factory v2 或 v3 工作流。",
      });
    }
    const professionContract = resolveFactoryJobContract(
      factory.config,
      "profession",
    );
    if (
      professionContract?.schemaVersion !== 1 &&
      professionContract?.schemaVersion !== 2
    ) {
      throw new ConflictException({
        code: "PROFESSION_CONTRACT_REQUIRED",
        message: "Factory 未启用受支持的 profession 声明式契约。",
      });
    }
    const packageContract = resolveFactoryJobContract(
      factory.config,
      "npk-package",
    );
    if (packageContract?.schemaVersion !== 1) {
      throw new ConflictException({
        code: "STYLE_PACKAGE_CONTRACT_REQUIRED",
        message: "Factory 未启用 npk-package v1 声明式契约。",
      });
    }
    const [hasProfessionWorker, hasPackageWorker] = await Promise.all([
      this.workers.hasEnabledCapability("profession"),
      this.workers.hasEnabledCapability("npk-package"),
    ]);
    if (!hasProfessionWorker) {
      throw new ConflictException({
        code: "PROFESSION_WORKER_REQUIRED",
        message: "尚无启用的 Worker 声明职业制作能力。",
      });
    }
    if (!hasPackageWorker) {
      throw new ConflictException({
        code: "STYLE_PACKAGE_WORKER_REQUIRED",
        message: "尚无启用的 Worker 声明最终候选 NPK 制作能力。",
      });
    }
    let payload: StyleSkillProductionJobPayload;
    try {
      payload =
        professionContract.schemaVersion === 2
          ? createStyleSkillProductionJobPayload(
              context,
              professionContract.profileId,
              2,
            )
          : createStyleSkillProductionJobPayload(
              context,
              professionContract.profileId,
              1,
            );
    } catch {
      throw new ConflictException({
        code: "STYLE_JOB_PAYLOAD_INVALID",
        message: "主题冻结包不符合内容绑定或声明式任务预算。",
      });
    }
    let packagePayload: StylePackageProductionJobPayloadV3;
    try {
      packagePayload = createPatchTaskPackagePayload(
        this.config,
        context,
        packageContract.profileId,
      );
    } catch {
      throw new ConflictException({
        code: "STYLE_PACKAGE_PROFILE_REQUIRED",
        message:
          "最终候选 NPK 的固定工具 profile 未完整配置或与 Factory 不一致。",
      });
    }
    const runInput = createPatchTaskRunInput(
      context,
      factory.config,
      idempotencyKey,
      payload,
      packagePayload,
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
            productionContractVersion: payload.schemaVersion === 2 ? 6 : 5,
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

  /**
   * 读取当前用户已通过任务的三项 Package V3 Artifact 元数据。
   *
   * @param runId 浏览器任务 path 中已校验的 Run UUID。
   * @param ownerUserId 从 Access Token 解析的稳定用户 ID，Repository 用它限制 Run 所有权。
   * @returns candidate、manifest、validation 固定顺序的脱敏元数据；不包含下载授权或对象 key。
   * @throws PATCH_TASK_ARTIFACTS_NOT_READY 当任一终态证据缺失、复用或不一致。
   */
  async findArtifacts(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView[]> {
    const artifacts = await this.patchTasks.findArtifacts(runId, ownerUserId);
    if (!artifacts) {
      throw new NotFoundException({
        code: "PATCH_TASK_ARTIFACTS_NOT_READY",
        message: "制作任务的候选包、清单或独立验证产物尚未完整就绪。",
      });
    }
    return artifacts;
  }

  /**
   * 按固定角色为当前用户拥有的 passed PatchTask 签发短期下载授权。
   *
   * @param runId 浏览器任务 path 中已校验的 Run UUID。
   * @param role Controller 通过 enum schema 校验的固定角色，不接受任意 Artifact ID。
   * @param ownerUserId 从 Access Token 解析的稳定用户 ID。
   * @returns 选中角色的元数据和短期 URL；不暴露 objectKey、bucket 或永久凭据。
   */
  async authorizeArtifactDownload(
    runId: string,
    role: PatchTaskArtifactRole,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactDownloadView> {
    // 第一步：重读完整三项终态证据与 Run 所有权，缺任一角色时禁止签发部分下载能力。
    const artifacts = await this.findArtifacts(runId, ownerUserId);
    const artifact = artifacts.find((candidate) => candidate.role === role);
    if (!artifact) {
      throw new NotFoundException({
        code: "PATCH_TASK_ARTIFACT_ROLE_NOT_FOUND",
        message: "制作任务不存在指定角色的已验证产物。",
      });
    }
    // 第二步：Artifact 领域二次确认同 Run 对象引用后才访问对象存储签名端口。
    const authorization = await this.artifacts.authorizeRunArtifactDownload(
      runId,
      artifact.artifactId,
      artifact.artifactName,
    );
    return {
      ...artifact,
      downloadUrl: authorization.downloadUrl,
      expiresAtUtc: authorization.expiresAtUtc,
    };
  }

  async reportSkillProduction(
    jobId: string,
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<void> {
    assertPatchTaskReportAccepted(
      await this.patchTasks.reportSkillProduction(jobId, input),
    );
  }

  async reportPackage(
    jobId: string,
    input: ReportPatchTaskPackageInput,
  ): Promise<void> {
    assertPatchTaskReportAccepted(
      await this.patchTasks.reportPackage(jobId, input),
    );
  }

  async resolveProfessionSkillExecution(
    jobId: string,
    input: ProfessionSkillLeaseInput,
  ): Promise<FrozenProfessionSkillExecutionContext> {
    const result = await this.patchTasks.resolveProfessionSkillExecution(
      jobId,
      input,
    );
    return requireProfessionExecutionContext(result);
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
    return requireProfessionProgress(result);
  }
}
