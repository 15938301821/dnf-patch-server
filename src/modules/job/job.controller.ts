/**
 * @fileoverview 同时暴露浏览器 PatchTask 接口与受 Worker token 保护的内部 Job lease/回填接口；不直接访问
 * Drizzle、不执行工具、不读取游戏目录，也不把任意路径/命令/模型密钥传给 Worker。
 * @module modules/job/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：全局 ApiAuthGuard 保护 REST；PatchTaskController 再用 AuthService 解析浏览器 access token 并将
 * 稳定 userId 交给 PatchTaskService；JobController 位于 `/internal/`，通过 WorkerTokenGuard 后用
 * JobService/SharedFxStageEvidenceService/PatchTaskService 处理受控 lease 和证据回填。
 * 输入输出：输入是严格 DTO、path id、浏览器 authorization 或内部 Worker token；输出是脱敏任务/状态封装，
 * 不返回密码、token、lease 以外的凭据、工具路径或 NPK/IMG 字节；浏览器下载端点只返回当前用户
 * 已通过任务中固定 Artifact 角色的短期对象存储 URL，不返回 object key、bucket 或长期凭据。
 * 副作用：Controller 自身不直接写数据库；下游 Service 可创建声明式 Run、领取/续租/完成 Job 或保存已验证
 * 阶段证据。所有实际状态转换必须由 Service/Repository 的事务完成。
 * 安全边界：浏览器身份与 Worker token 是不同信任主体；普通路由必须将稳定 userId 传给 PatchTaskService，
 * 内部路由不能用 body 伪造 runId/项目归属。认证成功不替代 lease fencing、attempt、Artifact 和职业证据校验。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  claimJobSchema,
  completeJobSchema,
  heartbeatJobSchema,
  surrenderJobSchema,
  type ClaimJobInput,
  type CompleteJobInput,
  type HeartbeatJobInput,
  type JobView,
  type SurrenderJobInput,
} from "./job.contracts.js";
import { JobService } from "./job.service.js";
import { idempotencyKeySchema } from "../run/run.contracts.js";
import { AuthService } from "../auth/auth.service.js";
import {
  createPatchTaskSchema,
  patchTaskArtifactRoleSchema,
  patchTaskSkillPreviewRoleSchema,
  reportPatchTaskPackageSchema,
  reportPatchTaskSkillProductionSchema,
  type CreatePatchTaskInput,
  type PatchTaskArtifactDownloadView,
  type PatchTaskArtifactRole,
  type PatchTaskArtifactView,
  type PatchTaskDetailView,
  type PatchTaskReferenceImageDownloadView,
  type PatchTaskSkillPreviewDownloadView,
  type PatchTaskSkillPreviewRole,
  type PatchTaskView,
  type ReportPatchTaskPackageInput,
  type ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import { PatchTaskService } from "./patch-task.service.js";
import { PatchTaskArchiveService } from "./patch-task-archive.service.js";
import {
  recordSharedFxStageEvidenceSchema,
  type RecordSharedFxStageEvidenceInput,
  type SharedFxStageEvidenceView,
} from "./shared-fx-stage-evidence.contracts.js";
import { SharedFxStageEvidenceService } from "./shared-fx-stage-evidence.service.js";
import {
  professionProductionProgressInputSchema,
  professionProductionProgressViewSchema,
  type ProfessionProductionProgressInput,
  type ProfessionProductionProgressView,
} from "./profession-production-progress.contracts.js";

@Controller("jobs")
/** 浏览器 PatchTask HTTP 适配层，认证后仅委托用户归属受控的 PatchTaskService。 */
export class PatchTaskController {
  /**
   * @param patchTasks 将浏览器制作任务编排为受 Guardrail 保护的 Run/计划记录。
   * @param auth 从 Authorization 解析稳定浏览器用户，不能信任请求 body 声明用户。
   */
  constructor(
    private readonly patchTasks: PatchTaskService,
    private readonly patchTaskArchive: PatchTaskArchiveService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 返回当前认证用户可见的 PatchTask 列表。
   * @param authorization 浏览器 Bearer token；AuthService 负责验证并解析稳定 userId。
   * @returns `{ data }` 封装的任务 ViewModel 列表，不含 Worker lease、密钥或对象正文。
   */
  @Get()
  async list(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskView[] }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.patchTasks.list(user.id) };
  }

  /**
   * 将当前认证用户拥有的终态 PatchTask 从默认列表软归档。
   * @param id path 中经 UUID schema 校验的 Run/任务标识。
   * @param authorization 浏览器 Bearer token；认证后仍由 Repository 复核稳定用户所有权。
   * @returns 204 且无正文；只表示列表归档，不表示取消任务或删除任何执行与 Artifact 证据。
   * @throws PATCH_TASK_NOT_FOUND 或 PATCH_TASK_ACTIVE，由归档 Service 做稳定映射。
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<void> {
    const user = await this.auth.requireBrowserUser(authorization);
    await this.patchTaskArchive.archive(id, user.id);
  }

  /**
   * 返回当前认证用户拥有的一项制作任务详情。
   * @param id path 中经 UUID schema 校验的 Run/任务标识。
   * @param authorization 浏览器 Bearer token；Service/Repository 继续执行稳定用户所有权检查。
   * @returns `{ data }` 封装的阶段、技能与模型吞吐 ViewModel，不含 Prompt、租约、对象 key 或 URL。
   */
  @Get(":id")
  async detail(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskDetailView }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.patchTasks.findDetail(id, user.id) };
  }

  /**
   * 为当前用户任务中一个固定技能的模型参考图签发短期读取授权。
   * @param id path 中已校验的任务 UUID。
   * @param skillId path 中已校验的技能 UUID；接口不接受 Artifact ID 或对象 key。
   * @param authorization 浏览器 Access Token；Service/Repository 继续复核 Run 所有权和当前 attempt。
   * @returns PNG 元数据与有限期 URL；URL 不表示图片可直接作为游戏 runtime 帧。
   */
  @Post(":id/skills/:skillId/reference-image/download-authorization")
  async authorizeReferenceImageDownload(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Param("skillId", new ZodValidationPipe(idSchema)) skillId: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskReferenceImageDownloadView }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.patchTasks.authorizeReferenceImageDownload(
        id,
        skillId,
        user.id,
      ),
    };
  }

  /**
   * 为当前用户任务中一个技能的固定预览角色签发短期读取授权。
   * @param role 只允许 source-frame、reference-image、aseprite-result；不接受 Artifact ID 或文件名。
   * @returns PNG 元数据、同帧公开字段与有限期 URL；历史任务缺图时返回统一未就绪错误。
   */
  @Post(":id/skills/:skillId/previews/:role/download-authorization")
  async authorizeSkillPreviewDownload(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Param("skillId", new ZodValidationPipe(idSchema)) skillId: string,
    @Param("role", new ZodValidationPipe(patchTaskSkillPreviewRoleSchema))
    role: PatchTaskSkillPreviewRole,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskSkillPreviewDownloadView }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.patchTasks.authorizeSkillPreviewDownload(
        id,
        skillId,
        role,
        user.id,
      ),
    };
  }

  /**
   * 创建或安全重放浏览器制作任务。
   * @param idempotencyKey 原始请求头，先按 Run 的受限 schema 验证。
   * @param authorization 浏览器 Bearer token，用于取得稳定 ownerUserId。
   * @param input 经过严格 PatchTask schema 校验的浏览器 DTO。
   * @returns `{ data }` 封装的 PatchTaskView；不代表 Worker 已领取或包已生成。
   * @throws IDEMPOTENCY_KEY_INVALID 或 Auth/Service 的所有权、策略、Worker capability 等稳定错误。
   */
  @Post()
  create(
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(createPatchTaskSchema))
    input: CreatePatchTaskInput,
  ): Promise<{ data: PatchTaskView }> {
    const parsed = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Idempotency-Key 请求头缺失或格式无效。",
      });
    }
    return this.auth
      .requireBrowserUser(authorization)
      .then((user) =>
        this.patchTasks
          .create(input, parsed.data, user.id)
          .then((data) => ({ data })),
      );
  }

  /**
   * 获取当前认证用户拥有的 PatchTask 最终 Artifact 摘要。
   * @param id 经 idSchema 校验的任务标识。
   * @param authorization 浏览器 Bearer token；所有权由 Service 使用稳定 userId 复核。
   * @returns `{ data }` 封装的 Artifact ViewModel，不返回内部对象 key、存储 URL 或资源字节。
   */
  @Get(":id/artifact")
  async artifact(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskArtifactView }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.patchTasks.findArtifact(id, user.id) };
  }

  /**
   * 获取当前用户拥有的 passed PatchTask 三项 Package V3 Artifact 摘要。
   * @param id path 中经 UUID schema 校验的 Run/任务标识。
   * @param authorization 浏览器 Access Token；Service/Repository 继续执行 Run 所有权检查。
   * @returns 固定顺序三项元数据，不含内部对象 key、URL 或正文。
   */
  @Get(":id/artifacts")
  async artifacts(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskArtifactView[] }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.patchTasks.findArtifacts(id, user.id) };
  }

  /**
   * 为当前用户任务的一个固定 Package V3 角色签发短期下载 URL。
   * @param id path 中经 UUID schema 校验的 Run/任务标识。
   * @param role path 中经 enum schema 校验的 candidate、manifest 或 validation；不接受 Artifact ID。
   * @param authorization 浏览器 Access Token；认证成功仍需 Service 复核 Run 所有权和三项终态证据。
   * @returns 选中角色的脱敏元数据和短期授权，不表示对象已下载、兼容或部署。
   */
  @Post(":id/artifacts/:role/download-authorization")
  async authorizeArtifactDownload(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
    @Param("role", new ZodValidationPipe(patchTaskArtifactRoleSchema))
    role: PatchTaskArtifactRole,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: PatchTaskArtifactDownloadView }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return {
      data: await this.patchTasks.authorizeArtifactDownload(id, role, user.id),
    };
  }
}

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
/** Worker 内部 Job HTTP 适配层，只有受控 token 通道可使用，仍不绕过事务 lease 校验。 */
export class JobController {
  /**
   * @param jobs Job 生命周期 Service，负责 lease/attempt/终态错误映射。
   * @param patchTasks PatchTask 专项回填 Service，负责职业生产和包报告的归属/状态规则。
   * @param sharedFxEvidence 共享特效阶段 Artifact 证据 Service。
   */
  constructor(
    private readonly jobs: JobService,
    private readonly patchTasks: PatchTaskService,
    private readonly sharedFxEvidence: SharedFxStageEvidenceService,
  ) {}

  /**
   * 为指定 Worker 原子领取一条兼容、可派发 Job。
   * @param input 经 claimJobSchema 校验的 Worker id；Worker 不能指定要领取的 Job。
   * @returns JobView 或 undefined（没有可领取任务）；收到 Job 不表示 lease 永久有效，必须使用返回 leaseId 续租/完成。
   */
  @Post("claim")
  claim(
    @Body(new ZodValidationPipe(claimJobSchema)) input: ClaimJobInput,
  ): Promise<JobView | undefined> {
    return this.jobs.claim(input);
  }

  /**
   * 续租一个当前 attempt 的 Job。
   * @param jobId path 中已校验 Job id。
   * @param input 已校验 Worker 身份和可选 leaseId；重试 attempt 缺少 leaseId 会被 Service 拒绝。
   * @returns 固定 `renewed` 响应；失败时不会延长过期/他人/旧 token 的 lease。
   */
  @Post(":id/heartbeat")
  async heartbeat(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(heartbeatJobSchema)) input: HeartbeatJobInput,
  ): Promise<{ status: "renewed" }> {
    await this.jobs.heartbeat(jobId, input);
    return { status: "renewed" };
  }

  /**
   * 显式交还 Handler 遇到瞬时 API 故障的当前 attempt，避免停止心跳后等待 reaper。
   * @returns requeued 表示稍后可重新领取；failed 表示 attempts 已耗尽并已收口 Run。
   */
  @Post(":id/surrender")
  async surrender(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(surrenderJobSchema)) input: SurrenderJobInput,
  ): Promise<{ status: "requeued" | "failed" }> {
    return { status: await this.jobs.surrender(jobId, input) };
  }

  /**
   * 读取当前 Profession Job 的冻结多技能进度。
   * @param jobId path 中已校验 UUID；不能由 Worker 替换为 Run 或其他 Job。
   * @param input body 中当前 Worker、leaseId 和 attempt，Repository 使用数据库时间再次复核。
   * @returns 冻结技能顺序与有限状态；全部 passed 时才有 Server 复算的 resultSha256。
   */
  @Post(":id/profession-production-progress")
  async professionProductionProgress(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(professionProductionProgressInputSchema))
    input: ProfessionProductionProgressInput,
  ): Promise<ProfessionProductionProgressView> {
    return professionProductionProgressViewSchema.parse(
      await this.patchTasks.resolveProfessionProductionProgress(jobId, input),
    );
  }

  /**
   * 完成一个当前 attempt 的 Job。
   * @param jobId path 中已校验 Job id。
   * @param input 已校验终态、Worker/lease 与结果或错误证据。
   * @returns 固定 `accepted` 响应；Repository 才会原子更新 Job/attempt/Run 及权威事件。
   */
  @Post(":id/complete")
  async complete(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(completeJobSchema)) input: CompleteJobInput,
  ): Promise<{ status: "accepted" }> {
    await this.jobs.complete(jobId, input);
    return { status: "accepted" };
  }

  /**
   * 回填共享特效 Job 的一个固定阶段 Artifact 证据。
   * @param jobId path 中已校验 Job id。
   * @param input 经严格阶段 schema 校验的 Artifact/lease/attempt 绑定。
   * @returns 保存后的证据 ViewModel；不表示六阶段均完整或 Job 可以通过完成。
   */
  @Post(":id/shared-fx-stage-evidence")
  async recordSharedFxStageEvidence(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(recordSharedFxStageEvidenceSchema))
    input: RecordSharedFxStageEvidenceInput,
  ): Promise<{ status: "accepted"; data: SharedFxStageEvidenceView }> {
    return {
      status: "accepted",
      data: await this.sharedFxEvidence.record(jobId, input),
    };
  }

  /**
   * 回填职业技能生产阶段的受控结果。
   * @param jobId path 中已校验 Job id。
   * @param input 已校验的生产报告；专项 Service 负责 Job/Run/Artifact/职业证据绑定。
   * @returns 固定 `accepted` 响应，不代表最终包已审核或部署。
   */
  @Post(":id/skill-production")
  async reportSkillProduction(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(reportPatchTaskSkillProductionSchema))
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<{ status: "accepted" }> {
    await this.patchTasks.reportSkillProduction(jobId, input);
    return { status: "accepted" };
  }

  /**
   * 校验 PatchTask 的打包阶段报告；当前 V2 未冻结封包能力，因此固定 fail-closed。
   * @param jobId path 中已校验 Job id。
   * @param input 已校验包报告；Service 复核精确 lease 后返回 409 且不写 package/Artifact。
   * @returns 未来冻结封包契约后的 `accepted` 响应；当前 V2 不会到达该返回。
   * @throws ConflictException 当前 V2 固定返回 `STYLE_PACKAGE_CAPABILITY_NOT_FROZEN`。
   */
  @Post(":id/package")
  async reportPackage(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(reportPatchTaskPackageSchema))
    input: ReportPatchTaskPackageInput,
  ): Promise<{ status: "accepted" }> {
    await this.patchTasks.reportPackage(jobId, input);
    return { status: "accepted" };
  }
}
