/**
 * @fileoverview 提供 Image Attempt 的 HTTP 创建路由适配；不直接查询数据库、不生成图片，也不裁决证据归属。
 * @module modules/image/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：浏览器请求先进入本 Controller，经 ZodValidationPipe 校验后调用 ImageService；Service 再调用 RunService 与 ImageRepository。
 * 输入输出：runId 来自 URL path，DTO 来自 body；输出为 ImageAttemptView（对外读取结构），而非数据库行或图片字节。
 * 副作用：Controller 本身不产生 I/O；下游可能读取 Run、证据元数据并写入 Image Attempt。
 * 安全边界：Zod 只保证输入格式，不替代 Service 对 Run 与证据归属的领域校验；响应不证明图片兼容、已部署或可直接运行。
 */
import { Body, Controller, Param, Post } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createImageAttemptSchema,
  type CreateImageAttemptInput,
  type ImageAttemptView,
} from "./image.contracts.js";
import { ImageService } from "./image.service.js";

@Controller("runs/:runId/image-attempts")
/**
 * Image Attempt 路由适配层。
 *
 * 由 NestJS 路由生命周期调用；只提取和校验 HTTP 输入并映射 Service 返回值，不承载数据库事务、所有权或状态机决策。
 */
export class ImageController {
  constructor(private readonly images: ImageService) {}

  @Post()
  /**
   * 创建绑定指定 Run 的 Image Attempt。
   *
   * @param runId URL path 中经 UUID schema 校验的 Run 标识。
   * @param input HTTP body 中经严格 DTO schema 校验的尝试元数据，尚未证明引用证据属于该 Run。
   * @returns 持久化成功后的脱敏 ImageAttemptView；不包含图片字节或模型敏感材料，也不证明运行时兼容性。
   * @throws IMAGE_MODEL_CALL_NOT_FOUND、IMAGE_OUTPUT_ARTIFACT_NOT_FOUND 或归属冲突，由 Service 映射为稳定 HTTP 失败；Controller 不直接执行数据库 I/O。
   */
  create(
    @Param("runId", new ZodValidationPipe(idSchema)) runId: string,
    @Body(new ZodValidationPipe(createImageAttemptSchema))
    input: CreateImageAttemptInput,
  ): Promise<ImageAttemptView> {
    return this.images.create(runId, input);
  }
}
