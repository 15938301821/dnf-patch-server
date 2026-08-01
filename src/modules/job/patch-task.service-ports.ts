/**
 * @fileoverview 定义 PatchTaskService 注入依赖的最小端口；不创建 Nest provider、不访问数据库、
 * 对象存储或 Worker，也不实现任务状态机。
 * @module modules/job/patch-task-service-ports
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - V6 详情修复期间收口既有 Service 文件规模
 *
 * 调用关系：PatchTaskService 构造函数使用这些结构类型约束已由 Nest 注入的正式 Service 与
 * Repository；单元测试也可提供同形状替身。输入输出沿用各领域公开契约，无运行时副作用。
 * 安全边界：端口只缩窄依赖能力，不能绕过用户所有权、Job lease、Artifact 授权或 Factory 冻结；
 * 变更方法签名时必须同步正式实现和 Service 测试替身。
 */
import type { FactoryService } from "../factory/factory.service.js";
import type { ProfessionService } from "../profession/profession.service.js";
import type { ProjectService } from "../project/project.service.js";
import type { CreateRunInput, RunCreateOptions } from "../run/run.contracts.js";
import type { RunService } from "../run/run.service.js";
import type { WorkerService } from "../worker/worker.service.js";
import type {
  PatchTaskArtifactView,
  PatchTaskDetailView,
  PatchTaskReportResult,
  PatchTaskView,
  ReportPatchTaskPackageInput,
  ReportPatchTaskSkillProductionInput,
} from "./patch-task.contracts.js";
import type { PatchTaskRepository } from "./patch-task.repository.js";
import type {
  PatchTaskPreviewArtifactDownloadPort,
  PatchTaskPreviewRepositoryPort,
} from "./patch-task-preview-authorization.service-support.js";
import type { ProfessionSkillLeaseInput } from "./profession-execution.contracts.js";
import type { ResolveProfessionExecutionContextResult } from "./profession-execution-context.js";
import type {
  ProfessionProductionProgressInput,
  ProfessionProductionProgressView,
} from "./profession-production-progress.contracts.js";

/** PatchTaskService 使用的任务持久化与预览查询最小能力。 */
export interface PatchTaskRepositoryPort extends PatchTaskPreviewRepositoryPort {
  list(ownerUserId: string): Promise<PatchTaskView[]>;
  findDetail(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskDetailView | undefined>;
  createPlan(
    pack: Parameters<PatchTaskRepository["createPlan"]>[0],
    skills: Parameters<PatchTaskRepository["createPlan"]>[1],
    disposition: Parameters<PatchTaskRepository["createPlan"]>[2],
  ): Promise<void>;
  findArtifact(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView | undefined>;
  findArtifacts(
    runId: string,
    ownerUserId: string,
  ): Promise<PatchTaskArtifactView[] | undefined>;
  reportSkillProduction(
    jobId: string,
    input: ReportPatchTaskSkillProductionInput,
  ): Promise<PatchTaskReportResult>;
  reportPackage(
    jobId: string,
    input: ReportPatchTaskPackageInput,
  ): Promise<PatchTaskReportResult>;
  resolveProfessionSkillExecution(
    jobId: string,
    input: ProfessionSkillLeaseInput,
  ): Promise<ResolveProfessionExecutionContextResult>;
  resolveProfessionProductionProgress(
    jobId: string,
    input: ProfessionProductionProgressInput,
  ): Promise<
    | { status: "accepted"; progress: ProfessionProductionProgressView }
    | {
        status:
          | "lease-mismatch"
          | "job-kind-mismatch"
          | "job-integrity-failed"
          | "production-integrity-failed";
      }
  >;
}

/** 职业模块只向任务创建暴露用户所有权校验后的冻结构建上下文。 */
export interface ProfessionBuildContextPort {
  getStyleBuildContext(
    professionId: string,
    styleId: string,
    ownerUserId: string,
  ): ReturnType<ProfessionService["getStyleBuildContext"]>;
}

/** Factory 查询最小端口；返回值仍由Factory服务执行存在性与可运行版本校验。 */
export interface FactoryLookupPort {
  get(id: string): ReturnType<FactoryService["get"]>;
}

/** Project 查询最小端口；任务创建只消费已持久化项目证据。 */
export interface ProjectLookupPort {
  get(id: string): ReturnType<ProjectService["get"]>;
}

/** Run 创建与延迟派发阻断端口；两项操作仍由Run领域维护事务和状态机。 */
export interface RunCreatePort {
  create(
    input: CreateRunInput,
    idempotencyKey: string,
    options?: RunCreateOptions,
  ): ReturnType<RunService["create"]>;
  blockDeferredDispatch(
    runId: string,
  ): ReturnType<RunService["blockDeferredDispatch"]>;
}

/** Worker能力只读端口；缺少任一固定能力时任务创建必须失败关闭。 */
export interface PatchTaskWorkerCapabilityPort {
  hasEnabledCapability(
    capability: "profession" | "npk-package",
  ): ReturnType<WorkerService["hasEnabledCapability"]>;
}

/** Artifact下载端口只允许按已验证Run与Artifact身份签发短期授权。 */
export type PatchTaskArtifactDownloadPort =
  PatchTaskPreviewArtifactDownloadPort;
