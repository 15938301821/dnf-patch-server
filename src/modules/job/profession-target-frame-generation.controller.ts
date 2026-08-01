/**
 * @fileoverview 暴露 Worker 当前 lease 下的 Profession V6 单帧真实生成入口；不接受 Prompt、模型、
 * endpoint、对象 key、路径或图片正文，也不返回私有存储位置和Provider响应。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：Worker按prepared manifest固定顺序提交当前lease与帧坐标；WorkerTokenGuard先验证机器
 * 共享凭据，ZodValidationPipe校验path/body，Generation Service再复核具体lease并编排唯一模型出站、
 * 同尺寸/同Alpha正规化和Artifact持久化。输入只含jobId与六字段DTO，输出是严格有限生成状态。
 * 副作用：Controller本身不访问数据库、模型或对象存储；全部副作用由Service/Repository承担。
 * 安全边界：Worker认证不等于拥有Job；响应必须再次严格解析，防止Prompt、对象key、图片字节、
 * Provider错误正文或数据库字段越过HTTP边界。passed只证明单帧Artifact完成，不证明封包或部署。
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  generateProfessionTargetFrameSchema,
  professionTargetFrameGenerationViewSchema,
  type GenerateProfessionTargetFrameInput,
  type ProfessionTargetFrameGenerationView,
} from "./profession-target-frame-generation.contracts.js";
import { ProfessionTargetFrameGenerationService } from "./profession-target-frame-generation.service.js";

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
/** Worker内部单帧生成HTTP适配层，不承载模型或持久化状态机。 */
export class ProfessionTargetFrameGenerationController {
  /** @param generations 编排官方PNG复读、模型出站、正规化和Artifact终态的领域Service。 */
  constructor(
    private readonly generations: ProfessionTargetFrameGenerationService,
  ) {}

  /**
   * 生成、观察或恢复当前attempt中的一个prepared可见帧。
   * @returns in-progress、blocked或passed脱敏View；响应中的额外字段会fail-closed。
   */
  @Post(":id/profession-target-frames/generate")
  async generate(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(generateProfessionTargetFrameSchema))
    input: GenerateProfessionTargetFrameInput,
  ): Promise<ProfessionTargetFrameGenerationView> {
    return professionTargetFrameGenerationViewSchema.parse(
      await this.generations.generate(jobId, input),
    );
  }
}
