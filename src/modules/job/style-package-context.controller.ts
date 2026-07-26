/**
 * @fileoverview 暴露当前 npk-package lease 的只读 V3 context；不返回对象 key、下载 URL、路径、
 * 命令或 Artifact 正文，也不注册 Worker capability。
 * @module modules/job/style-package-context-controller
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 首个纵向协议切片
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import { StylePackageContextService } from "./style-package-context.service.js";
import {
  requestStylePackageContextV3Schema,
  stylePackageContextEnvelopeV3Schema,
  type RequestStylePackageContextV3,
  type StylePackageContextEnvelopeV3,
} from "./style-package-production.contracts.js";

@Controller("internal/jobs")
@UseGuards(WorkerTokenGuard)
/** Package V3 context 的 Worker HTTP 适配层，具体 lease 和证据仍由 Service/Repository 复核。 */
export class StylePackageContextController {
  constructor(private readonly contexts: StylePackageContextService) {}

  /**
   * 返回当前 package attempt 的有序逐技能 ZIP 摘要与冻结工具 profile。
   * @param jobId path 中经 UUID schema 校验的 npk-package Job。
   * @param input body 中当前 Worker 的完整 lease fencing。
   * @returns 严格 V3 context 信封；未知响应字段会 fail-closed。
   */
  @Post(":id/style-package-context")
  async get(
    @Param("id", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(requestStylePackageContextV3Schema))
    input: RequestStylePackageContextV3,
  ): Promise<StylePackageContextEnvelopeV3> {
    return stylePackageContextEnvelopeV3Schema.parse(
      await this.contexts.get(jobId, input),
    );
  }
}
