/**
 * @fileoverview 暴露前端资源导入状态与任务创建信封，不接受路径或执行参数。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端资源导入业务直接需求）
 */
import { Body, Controller, Get, Post } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createResourceImportJobSchema,
  type CreateResourceImportJobInput,
  type ResourceImportJob,
  type ResourceImportOverview,
} from "./resource-import.contracts.js";
import { ResourceImportService } from "./resource-import.service.js";

@Controller("resource-imports")
export class ResourceImportController {
  constructor(private readonly resourceImports: ResourceImportService) {}

  @Get("overview")
  overview(): Promise<{ data: ResourceImportOverview }> {
    return this.resourceImports.overview().then((data) => ({ data }));
  }

  @Post("jobs")
  create(
    @Body(new ZodValidationPipe(createResourceImportJobSchema))
    input: CreateResourceImportJobInput,
  ): Promise<{ data: ResourceImportJob }> {
    void input;
    return this.resourceImports.create().then((data) => ({ data }));
  }
}
