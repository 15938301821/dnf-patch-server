/**
 * @fileoverview 提供最终 Artifact 的只读 Run 列表；写入只能走 Worker 上传生命周期。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { Controller, Get, Param } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { type ArtifactView } from "./artifact.contracts.js";
import { ArtifactService } from "./artifact.service.js";

@Controller("runs/:runId/artifacts")
export class ArtifactController {
  constructor(private readonly artifacts: ArtifactService) {}

  @Get()
  list(
    @Param("runId", new ZodValidationPipe(idSchema)) runId: string,
  ): Promise<ArtifactView[]> {
    return this.artifacts.listByRun(runId);
  }
}
