/**
 * @fileoverview 编排 Image Attempt 证据归属校验，不生成图片或访问本机文件。
 * @module image
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 1 evidence ownership
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RunService } from "../run/run.service.js";
import type {
  CreateImageAttemptInput,
  ImageAttemptView,
} from "./image.contracts.js";
import {
  ImageRepository,
  type ImageRepositoryPort,
} from "./image.repository.js";

interface RunLookupPort {
  get(id: string): ReturnType<RunService["get"]>;
}

@Injectable()
export class ImageService {
  constructor(
    @Inject(ImageRepository) private readonly images: ImageRepositoryPort,
    @Inject(RunService) private readonly runs: RunLookupPort,
  ) {}

  /**
   * 只接受属于目标 Run 的模型调用与输出 Artifact；复合外键防止校验后的竞态写入。
   */
  async create(
    runId: string,
    input: CreateImageAttemptInput,
  ): Promise<ImageAttemptView> {
    await this.runs.get(runId);
    if (input.modelCallId) {
      const modelCallRunId = await this.images.findModelCallRunId(
        input.modelCallId,
      );
      this.assertEvidenceRun(
        runId,
        modelCallRunId,
        "IMAGE_MODEL_CALL_NOT_FOUND",
        "IMAGE_MODEL_CALL_RUN_MISMATCH",
      );
    }
    if (input.outputArtifactId) {
      const artifactRunId = await this.images.findArtifactRunId(
        input.outputArtifactId,
      );
      this.assertEvidenceRun(
        runId,
        artifactRunId,
        "IMAGE_OUTPUT_ARTIFACT_NOT_FOUND",
        "IMAGE_OUTPUT_ARTIFACT_RUN_MISMATCH",
      );
    }
    return this.images.create(runId, randomUUID(), input);
  }

  private assertEvidenceRun(
    expectedRunId: string,
    actualRunId: string | undefined,
    missingCode: string,
    mismatchCode: string,
  ): void {
    if (!actualRunId) {
      throw new NotFoundException({
        code: missingCode,
        message: "Image Attempt 引用的证据不存在。",
      });
    }
    if (actualRunId !== expectedRunId) {
      throw new ConflictException({
        code: mismatchCode,
        message: "Image Attempt 引用的证据不属于目标 Run。",
      });
    }
  }
}
