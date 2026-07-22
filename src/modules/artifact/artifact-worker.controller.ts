/**
 * @fileoverview 暴露 Worker 租约绑定的 Artifact 上传、finalize 与下载授权；不接受 bucket 或 object key。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import {
  authorizeArtifactDownloadSchema,
  authorizeArtifactUploadSchema,
  finalizeArtifactUploadSchema,
  type ArtifactDownloadAuthorizationView,
  type ArtifactUploadAuthorizationView,
  type ArtifactView,
  type AuthorizeArtifactDownloadInput,
  type AuthorizeArtifactUploadInput,
  type FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";
import { ArtifactService } from "./artifact.service.js";

@Controller("internal/jobs/:jobId/artifacts")
@UseGuards(WorkerTokenGuard)
export class ArtifactWorkerController {
  constructor(private readonly artifacts: ArtifactService) {}

  @Post("uploads")
  authorizeUpload(
    @Param("jobId", new ZodValidationPipe(idSchema)) jobId: string,
    @Body(new ZodValidationPipe(authorizeArtifactUploadSchema))
    input: AuthorizeArtifactUploadInput,
  ): Promise<ArtifactUploadAuthorizationView> {
    return this.artifacts.authorizeUpload(jobId, input);
  }

  @Post("uploads/:uploadId/finalize")
  finalizeUpload(
    @Param("jobId", new ZodValidationPipe(idSchema)) jobId: string,
    @Param("uploadId", new ZodValidationPipe(idSchema)) uploadId: string,
    @Body(new ZodValidationPipe(finalizeArtifactUploadSchema))
    input: FinalizeArtifactUploadInput,
  ): Promise<ArtifactView> {
    return this.artifacts.finalizeUpload(jobId, uploadId, input);
  }

  @Post(":artifactId/download-authorizations")
  authorizeDownload(
    @Param("jobId", new ZodValidationPipe(idSchema)) jobId: string,
    @Param("artifactId", new ZodValidationPipe(idSchema)) artifactId: string,
    @Body(new ZodValidationPipe(authorizeArtifactDownloadSchema))
    input: AuthorizeArtifactDownloadInput,
  ): Promise<ArtifactDownloadAuthorizationView> {
    return this.artifacts.authorizeDownload(jobId, artifactId, input);
  }
}
