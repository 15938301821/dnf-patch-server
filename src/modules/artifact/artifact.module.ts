/**
 * @fileoverview 装配 Artifact 上传生命周期、对象授权与 orphan 回收；不执行本机文件工具。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import { ArtifactOrphanReaperService } from "./artifact-orphan-reaper.service.js";
import { ArtifactWorkerController } from "./artifact-worker.controller.js";
import { ArtifactController } from "./artifact.controller.js";
import { ArtifactRepository } from "./artifact.repository.js";
import { ArtifactService } from "./artifact.service.js";
import {
  ARTIFACT_UPLOAD_OPTIONS,
  type ArtifactUploadOptions,
} from "./artifact.tokens.js";

@Module({
  controllers: [ArtifactController, ArtifactWorkerController],
  providers: [
    {
      provide: ARTIFACT_UPLOAD_OPTIONS,
      useFactory: (
        config: ConfigService<Environment, true>,
      ): ArtifactUploadOptions => ({
        maxRunBytes: config.getOrThrow("OBJECT_STORAGE_MAX_RUN_BYTES", {
          infer: true,
        }),
        sessionTtlSeconds: config.getOrThrow(
          "OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS",
          { infer: true },
        ),
      }),
      inject: [ConfigService],
    },
    ArtifactRepository,
    ArtifactService,
    ArtifactOrphanReaperService,
  ],
  exports: [ArtifactService],
})
export class ArtifactModule {}
