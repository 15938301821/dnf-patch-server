/**
 * @fileoverview 装配浏览器 PatchTask、Worker Job lease、共享特效和资源/职业生产相关的受控业务入口；
 * 不实现本机 Worker 执行、不读取游戏目录、不调用任意模型或直接发送对象存储内容。
 * @module modules/job/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；PatchTaskController 使用 AuthModule 的身份能力，JobController 使用
 * Worker token Guard，多个 Service 通过 Run/Project/Factory/Profession/Worker 的公开 Service 复核冻结上下文。
 * JobReaperService 在应用生命周期内回收过期 lease；其他模块仅通过导出的 JobService 调用 Job 生命周期。
 * 输入输出：本文件只声明 Nest controller/provider 图，不解析 DTO、执行事务、签发 token 或返回任务数据。
 * 副作用：应用启动注册路由、Service 和单实例 reaper timer；没有即时领取/完成 Job、创建 Run 或调用 Worker。
 * 安全边界：跨模块不导入私有 Repository；Module 装配不授予 Worker 任意执行、浏览器跨用户访问、lease 绕过、
 * Artifact 信任或部署权限，实际不变量必须保留在各 Service/Repository 的事务中。
 */
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { FactoryModule } from "../factory/factory.module.js";
import { ProfessionModule } from "../profession/profession.module.js";
import { ProjectModule } from "../project/project.module.js";
import { RunModule } from "../run/run.module.js";
import { WorkerModule } from "../worker/worker.module.js";
import { JobController, PatchTaskController } from "./job.controller.js";
import { JobReaperService } from "./job-reaper.service.js";
import { JobRepository } from "./job.repository.js";
import { JobService } from "./job.service.js";
import { PatchTaskRepository } from "./patch-task.repository.js";
import { PatchTaskService } from "./patch-task.service.js";
import { SharedFxTaskController } from "./shared-fx-task.controller.js";
import { SharedFxTaskService } from "./shared-fx-task.service.js";
import { SharedFxStageEvidenceRepository } from "./shared-fx-stage-evidence.repository.js";
import { SharedFxStageEvidenceService } from "./shared-fx-stage-evidence.service.js";

@Module({
  imports: [
    AuthModule,
    FactoryModule,
    ProfessionModule,
    ProjectModule,
    RunModule,
    WorkerModule,
  ],
  controllers: [PatchTaskController, JobController, SharedFxTaskController],
  providers: [
    JobRepository,
    JobService,
    JobReaperService,
    PatchTaskRepository,
    PatchTaskService,
    SharedFxStageEvidenceRepository,
    SharedFxStageEvidenceService,
    SharedFxTaskService,
  ],
  exports: [JobService],
})
/** Job 领域的 Nest 依赖注入边界，只导出受控的 JobService。 */
export class JobModule {}
