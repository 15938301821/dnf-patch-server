/**
 * @fileoverview 装配全局对象存储端口；禁用态不构造 S3Client，也不读取默认凭据链。
 * @module common/storage
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：AppModule 导入本全局 Module；领域 Service 注入 OBJECT_STORAGE_PORT 或
 * ObjectStorageService。输入为 validateEnvironment 已解析配置，输出为 options、内部客户端与稳定
 * 端口 provider。副作用仅在启用态构造 S3Client；禁用态不连接网络或读取默认凭据链。
 * 安全边界：Access/Secret Key 只在工厂闭包内传给显式 SDK credentials，不得导出、记录或回显；
 * 启用但凭据缺失必须在应用装配时 fail-closed，Module 不承载 Artifact 归属规则。
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

/** 全局对象存储依赖装配单元；Module 本身不签发 URL、不读取对象或实现业务逻辑。 */
@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE_OPTIONS,
      // 只向业务端口暴露开关、容量与 TTL；endpoint 和凭据留在客户端工厂边界内。
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
      // 禁用时返回拒绝型适配器；启用时必须使用环境显式凭据，绝不触发 SDK 默认发现链。
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
        // 凭据仅在进程内存中交给 SDK 构造函数，返回端口不会暴露配置字段。
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
