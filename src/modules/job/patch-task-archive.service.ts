/**
 * @fileoverview 将浏览器删除制作任务的意图映射为终态 Run 软归档；不执行物理删除、取消 Worker
 * 或修改 Run/Job 的执行终态。
 * @module modules/job/patch-task-archive-service
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan N/A - 用户直接需求：制作任务列表增加删除功能
 *
 * 调用关系：PatchTaskController 完成 UUID 校验和浏览器认证后调用本 Service；本 Service 再调用
 * PatchTaskRepository 的事务命令，并将稳定领域结果映射为 HTTP 业务异常。
 * 输入输出：输入是 path 中的 Run ID 与 Access Token 解析出的稳定用户 ID；成功无响应正文，失败
 * 只暴露稳定错误码，不返回数据库状态、lease 或对象存储信息。
 * 副作用：成功时仅由 Repository 写 runs.archivedAt；不会删除或改写 Job、Attempt、Artifact、事件
 * 与 Package/技能证据。
 * 安全边界：认证不替代所有权检查；不存在、非 PatchTask 与跨用户统一 404，任何活动状态或残留
 * lease 统一 409，避免记录枚举和执行中任务被隐藏。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  PatchTaskRepository,
  type PatchTaskArchiveResult,
} from "./patch-task.repository.js";

interface PatchTaskArchiveRepositoryPort {
  archive(runId: string, ownerUserId: string): Promise<PatchTaskArchiveResult>;
}

/** 负责终态制作任务软归档规则和稳定 HTTP 错误映射的业务命令层。 */
@Injectable()
export class PatchTaskArchiveService {
  constructor(
    @Inject(PatchTaskRepository)
    private readonly patchTasks: PatchTaskArchiveRepositoryPort,
  ) {}

  /**
   * 归档当前浏览器用户拥有的终态制作任务。
   *
   * @param runId Controller path 中已通过 UUID schema 校验的 Run ID。
   * @param ownerUserId 由浏览器 Access Token 解析的稳定用户 ID，Repository 会再次用于所有权过滤。
   * @returns 成功时无正文；首次归档和重复归档具有相同结果。
   * @throws PATCH_TASK_NOT_FOUND 当任务不存在、不是制作任务或不属于当前用户时返回 404。
   * @throws PATCH_TASK_ACTIVE 当 Run/Job 尚活动或 lease 未清理时返回 409；此时数据库零写入。
   */
  async archive(runId: string, ownerUserId: string): Promise<void> {
    const result = await this.patchTasks.archive(runId, ownerUserId);
    if (result === "not-found") {
      throw new NotFoundException({
        code: "PATCH_TASK_NOT_FOUND",
        message: "制作任务不存在或当前用户无权操作。",
      });
    }
    if (result === "active") {
      throw new ConflictException({
        code: "PATCH_TASK_ACTIVE",
        message: "制作任务仍在运行，完成后才能从列表移除。",
      });
    }
  }
}
