/**
 * @fileoverview 暴露 Package V3 当前 attempt 的状态报告入口；不复用 V2 `/package`，也不完成 Job、
 * 不读取对象正文、不返回下载 URL 或启用 Worker capability。
 * @module modules/job/style-package-production-controller
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * 调用关系：受控 Worker 通过 `X-Worker-Token` 调用本 Controller；Controller 只做 path/body DTO 校验
 * 并委托 Service。输入输出：输入是 `reportStylePackageProductionV3Schema` 校验后的报告，输出固定
 * accepted。副作用：无直接数据库操作。安全边界：Guard 只认证 Worker 通道，不能替代 Service/Repository
 * 对 Job kind、lease、attempt、context SHA、Artifact 和 provenance 的 fail-closed 复核。
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  reportStylePackageProductionV3Schema,
  type ReportStylePackageProductionV3,
} from "./style-package-production.contracts.js";
import { StylePackageProductionService } from "./style-package-production.service.js";

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
/** Package V3 报告的 Worker HTTP 适配层，领域状态全部由 Service/Repository 决定。 */
export class StylePackageProductionController {
  /** @param productions Package V3 报告业务 Service。 */
  constructor(private readonly productions: StylePackageProductionService) {}

  /**
   * 封存当前 npk-package attempt 的构建状态或最终三 Artifact 报告。
   * @param jobId path 中经 UUID schema 校验的 npk-package Job。
   * @param input body 中经严格 V3 schema 校验的报告 DTO。
   * @returns 固定 accepted；不表示 Job complete、Run passed 或客户端兼容已证明。
   */
  @Post(":id/style-package-production")
  async report(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(reportStylePackageProductionV3Schema))
    input: ReportStylePackageProductionV3,
  ): Promise<{ status: "accepted" }> {
    await this.productions.report(jobId, input);
    return { status: "accepted" };
  }
}
