/**
 * @fileoverview 服务端根 Nest Module，集中装配配置、基础设施与纵向领域模块；不处理 HTTP
 * 请求、业务状态机或数据库事务。
 * @module application
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：main.ts 以 AppModule 创建 Nest 应用；本模块先通过 ConfigModule 校验环境，再向
 * 各领域 Module 提供数据库、认证与对象存储依赖。输入是进程环境和模块元数据，输出是 Nest
 * 依赖注入图。副作用仅来自被装配 provider 的生命周期；本文件自身不读写数据库或对象存储。
 * 安全边界：validateEnvironment 必须在 provider 实例化前 fail-closed；模块装配不能替代
 * Controller 输入校验、Guard 认证、Service 所有权检查或 transaction 原子性。
 */
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ArtifactModule } from "./modules/artifact/artifact.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { DatabaseModule } from "./common/db/database.module.js";
import { SecurityModule } from "./common/security/security.module.js";
import { ObjectStorageModule } from "./common/storage/object-storage.module.js";
import { validateEnvironment } from "./config/environment.js";
import { FactoryModule } from "./modules/factory/factory.module.js";
import { GuardrailModule } from "./modules/guardrail/guardrail.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ImageModule } from "./modules/image/image.module.js";
import { JobModule } from "./modules/job/job.module.js";
import { ResourceImportModule } from "./modules/job/resource-import.module.js";
import { ModelConfigurationModule } from "./modules/model-configuration/model-configuration.module.js";
import { NpkModule } from "./modules/npk/npk.module.js";
import { OpenAiModule } from "./modules/openai/openai.module.js";
import { ProfessionModule } from "./modules/profession/profession.module.js";
import { ProjectModule } from "./modules/project/project.module.js";
import { RunModule } from "./modules/run/run.module.js";
import { WorkerModule } from "./modules/worker/worker.module.js";

/**
 * 声明服务端唯一根依赖图。
 *
 * Module 只登记 Controller（HTTP 路由适配层）与 provider 依赖；领域能力由各纵向模块拥有，
 * 因而该类不导出可直接调用的业务方法，也不在装饰器中执行条件业务逻辑。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    SecurityModule,
    ObjectStorageModule,
    AuthModule,
    HealthModule,
    FactoryModule,
    ProjectModule,
    RunModule,
    JobModule,
    ResourceImportModule,
    ModelConfigurationModule,
    WorkerModule,
    ArtifactModule,
    NpkModule,
    ProfessionModule,
    ImageModule,
    GuardrailModule,
    OpenAiModule,
  ],
})
export class AppModule {}
