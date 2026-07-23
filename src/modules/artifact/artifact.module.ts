/**
 * @fileoverview 装配 Artifact 上传生命周期、对象授权与 orphan 回收依赖；不执行本机文件工具、
 * 不处理业务状态机，也不直接访问游戏目录或对象正文。
 * @module modules/artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：AppModule 导入本 Module；Nest 以本文件的 provider 图创建两个 Controller、Repository、
 * Service 和定时 reaper，并向 NPK/职业等模块导出 ArtifactService。上游 HTTP/Worker 请求由 Controller
 * 进入，下游对象存储与数据库由被注入的基础设施 provider 提供。
 * 输入输出：输入为经过全局环境校验的对象存储配额和短期 URL TTL，输出为可注入的 ArtifactService，
 * 而非对外 API 响应或对象存储凭据。
 * 副作用：本文件仅声明 Nest 依赖注入装配；实际事务、行锁、会话写入、哈希复核与对象 I/O 在 provider
 * 方法被调用时发生。
 * 安全边界：环境配置缺失时必须在启动阶段 fail-closed；Module 装配不替代 Worker token 认证、Run 归属、
 * attempt/lease fencing、SHA-256 复核或对象存储私有访问控制。
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
/**
 * Artifact 纵向领域的 Nest 装配入口。
 *
 * AppModule 仅导入本类，跨模块只能通过导出的 ArtifactService 使用 Artifact 元数据能力；本类不承载
 * HTTP 参数处理、数据库事务或 Worker 调度逻辑，避免把装配层误当作可绕过的业务入口。
 */
export class ArtifactModule {}
