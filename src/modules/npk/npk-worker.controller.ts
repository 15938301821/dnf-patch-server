/**
 * @fileoverview 暴露 Worker 精确租约绑定的 Inventory 回填入口；不接受 Project、Run 或存储路径选择。
 * @module npk
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - Worker Inventory 直接实施需求
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  createWorkerInventorySchema,
  type CreateWorkerInventoryInput,
  type InventoryView,
} from "./npk.contracts.js";
import { NpkService } from "./npk.service.js";

@Controller("internal/jobs/:jobId/npk-inventories")
@UseGuards(WorkerTokenGuard)
export class NpkWorkerController {
  constructor(private readonly inventories: NpkService) {}

  @Post()
  create(
    @Param("jobId", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(createWorkerInventorySchema))
    input: CreateWorkerInventoryInput,
  ): Promise<InventoryView> {
    return this.inventories.createFromWorker(jobId, input);
  }
}
