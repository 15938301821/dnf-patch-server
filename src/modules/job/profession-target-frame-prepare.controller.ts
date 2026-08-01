/**
 * @fileoverview 暴露 Worker 当前 lease 下的 Profession V6 target-frame prepare 入口；不接受对象 key、
 * 路径、Provider、模型、Prompt 或工具参数，也不返回逐帧数据库行和私有存储位置。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：仓库外 Worker 以 X-Worker-Token 调用；Guard 在进入 Controller 前认证机器共享凭据，
 * ZodValidationPipe 校验 path/body，Service 再验证具体 lease、Artifact、source 和逐帧事实。
 * 输入输出：POST body 是 exact lease 与 finalized manifest Artifact 声明，响应是严格 prepared ViewModel。
 * 副作用：本 HTTP 路由适配层不读数据库或对象存储；全部业务副作用由 Service/Repository 承担。
 * 安全边界：Worker token 认证不等于目标 Job 所有权；响应 schema 必须继续拒绝对象 key、本机路径、
 * Prompt 和模型配置等额外字段，防止内部证据越过 HTTP 边界。
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  prepareProfessionTargetFramesSchema,
  professionTargetFramePreparationViewSchema,
  registerProfessionTargetFrameSourceSchema,
  professionTargetFrameSourceViewSchema,
  type PrepareProfessionTargetFramesInput,
  type ProfessionTargetFramePreparationView,
  type RegisterProfessionTargetFrameSourceInput,
  type ProfessionTargetFrameSourceView,
} from "./profession-target-frame-prepare.contracts.js";
import { ProfessionTargetFramePrepareService } from "./profession-target-frame-prepare.service.js";
import { ProfessionTargetFrameSourceService } from "./profession-target-frame-source.service.js";

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
/** Worker 内部逐帧 prepare 的 HTTP 适配层，不承载对象解析或数据库状态机。 */
export class ProfessionTargetFramePrepareController {
  /** @param preparations 编排双对象复读、逐帧绑定和两次短事务的业务 Service。 */
  constructor(
    private readonly preparations: ProfessionTargetFramePrepareService,
    private readonly sources: ProfessionTargetFrameSourceService,
  ) {}

  /**
   * 首次准备或幂等读取当前 attempt 的单技能逐帧目标事实。
   * @param jobId URL path 中经 UUID schema 校验的 Profession Job 标识。
   * @param input body 中经严格 schema 校验的 lease 与 manifest Artifact 声明。
   * @returns 只含技能、manifest ID 和计数的 prepared 回执；不证明目标图片已经生成。
   * @throws Service 映射 lease、合同、Artifact、source、manifest 和存储失败的稳定业务异常。
   */
  @Post(":id/profession-target-frames/prepare")
  async prepare(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(prepareProfessionTargetFramesSchema))
    input: PrepareProfessionTargetFramesInput,
  ): Promise<ProfessionTargetFramePreparationView> {
    return professionTargetFramePreparationViewSchema.parse(
      await this.preparations.prepare(jobId, input),
    );
  }

  /** 登记 finalized 官方逐帧 PNG；只返回帧身份和 Artifact 摘要，不返回对象位置或正文。 */
  @Post(":id/profession-target-frames/source")
  async registerSource(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(registerProfessionTargetFrameSourceSchema))
    input: RegisterProfessionTargetFrameSourceInput,
  ): Promise<ProfessionTargetFrameSourceView> {
    return professionTargetFrameSourceViewSchema.parse(
      await this.sources.register(jobId, input),
    );
  }
}
