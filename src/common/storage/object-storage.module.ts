/**
 * @fileoverview 装配全局对象存储端口；禁用态不构造 S3Client，也不读取默认凭据链。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import { DisabledObjectStorageClient } from "./disabled-object-storage.client.js";
import type {
  ObjectStorageClientPort,
  ObjectStorageOptions,
} from "./object-storage.client.js";
import { ObjectStorageService } from "./object-storage.service.js";
import {
  OBJECT_STORAGE_CLIENT,
  OBJECT_STORAGE_OPTIONS,
  OBJECT_STORAGE_PORT,
} from "./object-storage.tokens.js";
import { createS3ObjectStorageClient } from "./s3-object-storage.client.js";

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE_OPTIONS,
      useFactory: (
        config: ConfigService<Environment, true>,
      ): ObjectStorageOptions => ({
        enabled: config.getOrThrow("OBJECT_STORAGE_ENABLED", { infer: true }),
        maxObjectBytes: config.getOrThrow("OBJECT_STORAGE_MAX_OBJECT_BYTES", {
          infer: true,
        }),
        signedUrlTtlSeconds: config.getOrThrow(
          "OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS",
          { infer: true },
        ),
      }),
      inject: [ConfigService],
    },
    {
      provide: OBJECT_STORAGE_CLIENT,
      useFactory: (
        config: ConfigService<Environment, true>,
      ): ObjectStorageClientPort => {
        if (!config.getOrThrow("OBJECT_STORAGE_ENABLED", { infer: true })) {
          return new DisabledObjectStorageClient();
        }
        const accessKeyId = config.get("OBJECT_STORAGE_ACCESS_KEY", {
          infer: true,
        });
        const secretAccessKey = config.get("OBJECT_STORAGE_SECRET_KEY", {
          infer: true,
        });
        if (!accessKeyId || !secretAccessKey) {
          throw new Error("OBJECT_STORAGE_CREDENTIALS_MISSING");
        }
        return createS3ObjectStorageClient({
          endpoint: config.getOrThrow("OBJECT_STORAGE_ENDPOINT", {
            infer: true,
          }),
          region: config.getOrThrow("OBJECT_STORAGE_REGION", { infer: true }),
          bucket: config.getOrThrow("OBJECT_STORAGE_BUCKET", { infer: true }),
          accessKeyId,
          secretAccessKey,
          forcePathStyle: config.getOrThrow("OBJECT_STORAGE_FORCE_PATH_STYLE", {
            infer: true,
          }),
        });
      },
      inject: [ConfigService],
    },
    ObjectStorageService,
    { provide: OBJECT_STORAGE_PORT, useExisting: ObjectStorageService },
  ],
  exports: [OBJECT_STORAGE_PORT, ObjectStorageService],
})
export class ObjectStorageModule {}
