/**
 * @fileoverview 管理受控 Worker 的注册一致性、短时心跳 freshness、禁用状态和 capability 查询；不领取
 * Job、不签发 lease、不执行工具、不接收命令/路径，也不验证 Worker 本机资源。
 * @module modules/worker/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：WorkerController 调用 register/heartbeat/disable；Job/Run 创建链路调用
 * hasEnabledCapability 决定是否允许创建需要特定 kind 的新任务；validateWorkerReregistration 保护
 * 同 id 的不可变注册身份。
 * 输入输出：输入是已校验注册数据、Worker id 或受控 Job kind；输出是 WorkerView、布尔能力结果或无值，
 * 不返回 token、lease、Job payload、本机目录或工具配置。
 * 副作用：register/disable/heartbeat 更新 workers 表；hasEnabledCapability 只读。注册操作使用行锁事务，
 * 不创建 Job、outbox、Artifact 或事件。
 * 安全边界：能力声明必须同时满足未禁用、最近心跳和严格 JSON schema；过期/缺失证据返回 false，不能
 * 基于历史登记乐观创建任务。register 禁止禁用记录复活以及同 id 修改显示名/capabilities。
 */
import { ConflictException, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { workers } from "../../common/db/schema.js";
import type { AllowedJobKind } from "../guardrail/guardrail.contracts.js";
import {
  type RegisterWorkerInput,
  type WorkerView,
  workerCapabilitiesSchema,
} from "./worker.contracts.js";
import { validateWorkerReregistration } from "./worker-registration.js";

/**
 * 新 Job 创建时认为 Worker 仍可用的最大心跳年龄。
 * 此值只用于创建前 fail-closed 资格检查，不会撤销已发出的 lease，也不证明本机工具链仍健康。
 */
const WORKER_HEARTBEAT_FRESHNESS_MS = 60_000;

@Injectable()
/** Worker 注册状态业务层，封装数据库事务、freshness 与身份不可变规则。 */
export class WorkerService {
  /** @param connection 应用生命周期管理的 Drizzle 数据库连接。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 判断是否有启用且心跳仍在 freshness 窗口内的 Worker 声明指定 capability。
   *
   * @param capability Job/Run 创建链路所需的受控 Job kind。
   * @returns 至少一个未禁用、心跳新鲜且数据库 capability JSON 通过 schema 的 Worker 存在时返回 true。
   * @remarks 缺失或过期心跳必须 fail-closed，避免仅凭历史注册记录接受无法执行的新任务；本检查不推断
   * 本机路径、资源内容或工具哈希，也不改变已发出的 Job lease。
   */
  async hasEnabledCapability(capability: AllowedJobKind): Promise<boolean> {
    const rows = await this.connection.database
      .select({
        capabilities: workers.capabilities,
        lastHeartbeatAt: workers.lastHeartbeatAt,
      })
      .from(workers)
      .where(eq(workers.disabled, false));
    const heartbeatCutoff = Date.now() - WORKER_HEARTBEAT_FRESHNESS_MS;
    return rows.some(
      (row) =>
        row.lastHeartbeatAt !== null &&
        row.lastHeartbeatAt.getTime() >= heartbeatCutoff &&
        workerCapabilitiesSchema.parse(row.capabilities).includes(capability),
    );
  }

  /**
   * 首次注册 Worker，或仅在同 id 的声明身份完全一致时刷新心跳。
   *
   * 步骤 1：对 id 行执行 `FOR UPDATE`，防止并发注册互相覆盖；步骤 2：已禁用记录直接拒绝，不能通过
   * 重复注册复活；步骤 3：已有记录必须通过不可变显示名/capability 比对后才更新心跳；步骤 4：不存在
   * 时插入固定排序后的 capability 集合。任一冲突分支都不创建 Job 或更改其他 Worker。
   *
   * @param input Controller 已按严格 schema 解析的注册声明。
   * @returns 当前 Worker 的脱敏 ViewModel。
   * @throws WORKER_DISABLED 或 WORKER_REGISTRATION_CONFLICT 当复活或身份变更请求被拒绝时抛出。
   */
  async register(input: RegisterWorkerInput): Promise<WorkerView> {
    const now = new Date();
    const capabilities = [...input.capabilities].sort();
    return this.connection.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(workers)
        .where(eq(workers.id, input.id))
        .limit(1)
        .for("update");
      if (existing?.disabled) {
        throw new ConflictException({
          code: "WORKER_DISABLED",
          message: "已禁用 Worker 不能通过重复注册恢复。",
        });
      }
      if (existing) {
        const existingCapabilities = workerCapabilitiesSchema.parse(
          existing.capabilities,
        );
        if (
          validateWorkerReregistration(
            { ...existing, capabilities: existingCapabilities },
            input.displayName,
            capabilities,
          ) !== "accepted"
        ) {
          throw new ConflictException({
            code: "WORKER_REGISTRATION_CONFLICT",
            message: "已注册 Worker 的身份或能力与本次注册不一致。",
          });
        }
        await transaction
          .update(workers)
          .set({ lastHeartbeatAt: now })
          .where(eq(workers.id, input.id));
        return toWorkerView({
          ...existing,
          lastHeartbeatAt: now,
          capabilities: existingCapabilities,
        });
      }
      await transaction.insert(workers).values({
        id: input.id,
        displayName: input.displayName,
        capabilities,
        disabled: false,
        lastHeartbeatAt: now,
        createdAt: now,
      });
      return toWorkerView({
        id: input.id,
        displayName: input.displayName,
        capabilities,
        disabled: false,
        lastHeartbeatAt: now,
        createdAt: now,
      });
    });
  }

  /**
   * 单向标记 Worker 禁用。
   * @param id 已由 Controller 校验的 Worker 标识。
   * @returns 无返回值；未命中 id 也不会抛错，调用方的后续 heartbeat 会得到不可用状态。
   * @sideEffect 更新 workers.disabled，不回收 Job lease 或删除注册历史。
   */
  async disable(id: string): Promise<void> {
    await this.connection.database
      .update(workers)
      .set({ disabled: true })
      .where(eq(workers.id, id));
  }

  /**
   * 仅为仍启用的 Worker 刷新最后心跳。
   * @param id 已校验的 Worker 标识。
   * @returns 恰好更新一行时为 true；false 表示不存在或已经禁用。
   * @sideEffect 更新 workers.lastHeartbeatAt，不检查 capability、不领取 Job，也不延长任何 lease。
   */
  async heartbeat(id: string): Promise<boolean> {
    const result = await this.connection.database
      .update(workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(and(eq(workers.id, id), eq(workers.disabled, false)));
    return result[0].affectedRows === 1;
  }
}

/**
 * 将 Worker 数据库行映射为不含 token/lease/本机配置的公开状态。
 * @param row workers 表中的单行，capabilities 已在读取/写入边界受到 schema 约束。
 * @returns WorkerView；心跳缺失时省略 lastHeartbeatAtUtc，调用方仍须按 freshness 重新判断可用性。
 */
function toWorkerView(row: typeof workers.$inferSelect): WorkerView {
  return {
    id: row.id,
    displayName: row.displayName,
    capabilities: row.capabilities,
    disabled: row.disabled,
    ...(row.lastHeartbeatAt
      ? { lastHeartbeatAtUtc: row.lastHeartbeatAt.toISOString() }
      : {}),
    createdAtUtc: row.createdAt.toISOString(),
  };
}
