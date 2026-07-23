/**
 * @fileoverview 在事务中持久化 Run、Guardrail 决策、初始 Job、权威事件和 outbox，并查询 Run/事件/幂等
 * 记录；不解析 HTTP DTO、不校验 Factory/Project/Snapshot、不给 Worker 发 lease，也不直接广播 Socket。
 * @module modules/run/repository
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：RunService 在完成跨模块领域校验后调用本类；RunOutboxRepository/Dispatcher 读取本类写入的
 * outbox，随后通过 RunGateway 通知客户端；Job 等模块读取 RunView 而不应依赖本类内部行类型。
 * 输入输出：输入是已验证的创建 DTO、服务器 id、Guardrail 决策、幂等键/指纹与受控选项；输出是脱敏
 * Run/Job/Event ViewModel 或 undefined，不返回数据库连接、Worker token、模型凭据或对象存储内容。
 * 副作用：create 与 blockDeferredDispatch 都在单一数据库事务内写多个表；events/find 查询只读。
 * 安全边界：Run、决策、Job、初始事件和 outbox 必须一起提交或回滚；deny 决策不会创建 Job；延迟派发
 * 补偿只阻断 dispatchReadyAt 为 null 的 queued Job，不能误伤已领取/已派发任务。安全状态读取时重新校验
 * immutable flags，避免数据库值被静默提升为部署/兼容证明。
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq, gt, max } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { immutableSafetyStateSchema } from "../../common/contracts/index.js";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  guardrailDecisions,
  jobs,
  outboxEvents,
  runEvents,
  runs,
} from "../../common/db/schema.js";
import { sha256Json } from "../../common/utils/canonical.js";
import type { GuardrailEvaluation } from "../guardrail/guardrail.contracts.js";
import type { JobView } from "../job/job.contracts.js";
import type {
  CreateRunInput,
  RunCreateOptions,
  RunEventQuery,
  RunEventView,
  RunModelContext,
  RunView,
} from "./run.contracts.js";

/**
 * Run 创建事务提交后交给 Service/调用方的最小结果。
 * event 已写入权威 events 与 outbox；真正 Socket 广播仍由提交后的 dispatcher 完成。
 */
export interface CreateRunTransactionResult {
  run: RunView;
  jobs: JobView[];
  event: RunEventView;
}

/**
 * Project 范围内 Idempotency-Key 查询结果。
 * requestFingerprintSha256 缺失代表旧记录，Service 必须拒绝重放而不是凭 key 字符串猜测等价。
 */
export interface RunIdempotencyRecord {
  run: RunView;
  requestFingerprintSha256?: string;
}

@Injectable()
/** Run 持久化边界；Controller/Gateway 不应绕过 Service 直接注入事务实现。 */
export class RunRepository {
  /** @param connection 应用生命周期管理的 Drizzle 数据库连接，提供事务和行锁能力。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 按服务器 id 查询 Run。
   * @param id 已由上游 schema 校验的 Run 标识。
   * @returns RunView 或 undefined；未找到由 Service 转为 RUN_NOT_FOUND。
   */
  async findById(id: string): Promise<RunView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    return row ? toRunView(row) : undefined;
  }

  /**
   * 查询固定角色模型调用所需的最小 Run 上下文。
   * @param id Run 标识。
   * @returns modelEgressAuthorized 与可选 ownerUserId；不返回凭据、Prompt、Job payload 或完整 Run。
   */
  async findModelContext(id: string): Promise<RunModelContext | undefined> {
    const [row] = await this.connection.database
      .select({
        modelEgressAuthorized: runs.modelEgressAuthorized,
        ownerUserId: runs.ownerUserId,
      })
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    return row
      ? {
          modelEgressAuthorized: row.modelEgressAuthorized,
          ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
        }
      : undefined;
  }

  /**
   * 在同一 Project 内按 Idempotency-Key 查询已有 Run。
   * @param projectId 幂等键的隔离范围。
   * @param idempotencyKey 已由 Controller schema 校验的键。
   * @returns Run 与可选服务器请求指纹；不存在返回 undefined，旧记录可缺少指纹。
   */
  async findByIdempotency(
    projectId: string,
    idempotencyKey: string,
  ): Promise<RunIdempotencyRecord | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row
      ? {
          run: toRunView(row),
          ...(row.requestFingerprintSha256
            ? { requestFingerprintSha256: row.requestFingerprintSha256 }
            : {}),
        }
      : undefined;
  }

  /**
   * 按客户端关联 id 查询同一 Project 的已有 Run。
   * @param projectId Project 隔离范围。
   * @param clientRunId 客户端在创建 DTO 中声明的关联标识。
   * @returns 匹配 Run 或 undefined；用于 MySQL 并发冲突后的稳定错误判定。
   */
  async findByClientRunId(
    projectId: string,
    clientRunId: string,
  ): Promise<RunView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(runs)
      .where(
        and(eq(runs.projectId, projectId), eq(runs.clientRunId, clientRunId)),
      )
      .limit(1);
    return row ? toRunView(row) : undefined;
  }

  /**
   * 原子创建 Run、全部 Guardrail 决策、可派发 Job、初始权威事件和 outbox 记录。
   *
   * 步骤 1：写入 Run，所有不可提升安全状态强制为 false，deny 时直接标记 blocked/finished；步骤 2：
   * 保存每个 Guardrail 决策供审计；步骤 3：仅当没有 deny 时生成 Job，deferJobDispatch 时保持
   * dispatchReadyAt=null；步骤 4：无论 blocked/queued 都写 sequence=0 权威事件和同事务 outbox。
   * 任一数据库失败导致全体回滚，禁止留下有 Job 无 Run、事件无 outbox 或广播先于提交的状态。
   *
   * @param input Service 已验证 Factory/Project/Snapshot/contract 的创建 DTO。
   * @param idempotencyKey Project 范围内、已解析的请求键。
   * @param requestFingerprintSha256 覆盖完整请求和可选 owner 的服务器 SHA-256。
   * @param id Service 生成的 Run UUID。
   * @param decisions 纯 Guardrail 评估结果；任一 deny 会阻断 Job 创建。
   * @param options 受控内部选项，可能延迟 Job 派发或绑定稳定 owner。
   * @returns 已提交后可使用的 Run/Job/Event ViewModel。
   * @sideEffect 在一个事务内插入 runs、guardrailDecisions、可选 jobs、runEvents 和 outboxEvents。
   */
  async create(
    input: CreateRunInput,
    idempotencyKey: string,
    requestFingerprintSha256: string,
    id: string,
    decisions: GuardrailEvaluation[],
    options: RunCreateOptions = {},
  ): Promise<CreateRunTransactionResult> {
    const now = new Date();
    const blocked = decisions.some((decision) => decision.decision === "deny");
    return this.connection.database.transaction(async (transaction) => {
      await transaction.insert(runs).values({
        id,
        ...(options.ownerUserId ? { ownerUserId: options.ownerUserId } : {}),
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        clientRunId: input.clientRunId,
        idempotencyKey,
        action: input.action,
        status: blocked ? "blocked" : "queued",
        currentStage: blocked ? "guardrail" : "queued",
        requestSha256: input.requestSha256.toUpperCase(),
        requestFingerprintSha256,
        serverConnectionEnabled: true,
        modelEgressAuthorized: input.modelEgressAuthorized,
        deploymentAuthorized: false,
        deploymentPerformed: false,
        fullSkillCoverageProven: false,
        clientCompatibilityProven: false,
        createdAt: now,
        updatedAt: now,
        ...(blocked ? { finishedAt: now } : {}),
      });
      await transaction.insert(guardrailDecisions).values(
        decisions.map((decision) => ({
          id: randomUUID(),
          runId: id,
          ...decision,
          details: {},
          createdAt: now,
        })),
      );
      const jobViews: JobView[] = (blocked ? [] : input.jobs).map((job) => {
        const jobId = randomUUID();
        return {
          id: jobId,
          runId: id,
          kind: job.kind,
          status: "queued",
          payload: job.payload,
          payloadSha256: sha256Json(job.payload),
          attemptCount: 0,
          maxAttempts: job.maxAttempts,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
        };
      });
      if (jobViews.length > 0) {
        await transaction.insert(jobs).values(
          jobViews.map((job) => ({
            id: job.id,
            runId: id,
            kind: job.kind,
            status: job.status,
            payload: job.payload,
            payloadSha256: job.payloadSha256,
            dispatchReadyAt: options.deferJobDispatch ? null : now,
            attemptCount: 0,
            maxAttempts: job.maxAttempts,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
      const event: RunEventView = {
        runId: id,
        sequence: 0,
        level: "info",
        stage: blocked ? "guardrail" : "queued",
        message: blocked
          ? "Run 被 Guardrail 阻断；未创建任何 Worker 任务。"
          : "Run 已进入服务端队列；部署保持禁用。",
        createdAtUtc: now.toISOString(),
      };
      await transaction.insert(runEvents).values({
        id: randomUUID(),
        runId: id,
        sequence: 0,
        level: event.level,
        stage: event.stage,
        message: event.message,
        createdAt: now,
      });
      await transaction.insert(outboxEvents).values({
        id: randomUUID(),
        topic: "run.event",
        aggregateId: id,
        payload: { ...event },
        createdAt: now,
      });
      return {
        run: {
          id,
          projectId: input.projectId,
          snapshotId: input.snapshotId,
          clientRunId: input.clientRunId,
          action: input.action,
          status: blocked ? "blocked" : "queued",
          currentStage: blocked ? "guardrail" : "queued",
          requestSha256: input.requestSha256.toUpperCase(),
          serverConnectionEnabled: true,
          modelEgressAuthorized: input.modelEgressAuthorized,
          deploymentAuthorized: false,
          deploymentPerformed: false,
          fullSkillCoverageProven: false,
          clientCompatibilityProven: false,
          createdAtUtc: now.toISOString(),
          updatedAtUtc: now.toISOString(),
          ...(blocked ? { finishedAtUtc: now.toISOString() } : {}),
        },
        jobs: jobViews,
        event,
      };
    });
  }

  /**
   * 仅补偿尚未开放领取的延迟派发 Run，避免计划失败留下永久 queued Job。
   *
   * 事务内锁定 Run 与其所有 Job；只有 Run=queued 且每个 Job=queued 且 dispatchReadyAt=null 时才将 Job/Run
   * 同时改为 blocked，并写入下一条权威 error 事件与 outbox。任何 Job 已准备派发、领取或终态时返回 false，
   * 让上层拒绝不安全的“补偿”。
   *
   * @param runId 需要补偿的 Run 标识。
   * @returns 完成阻断或已是 blocked 时为 true；状态不适合安全补偿或缺失 Run 时为 false。
   * @sideEffect 锁定 Run/Job，成功时更新两表并插入 event/outbox；不会删除任何审计记录。
   */
  async blockDeferredDispatch(runId: string): Promise<boolean> {
    return this.connection.database.transaction(async (transaction) => {
      const [run] = await transaction
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
        .for("update");
      if (!run) return false;
      if (run.status === "blocked") return true;
      if (run.status !== "queued") return false;
      const deferredJobs = await transaction
        .select({
          id: jobs.id,
          status: jobs.status,
          dispatchReadyAt: jobs.dispatchReadyAt,
        })
        .from(jobs)
        .where(eq(jobs.runId, runId))
        .for("update");
      if (
        deferredJobs.length === 0 ||
        deferredJobs.some(
          (job) => job.status !== "queued" || job.dispatchReadyAt !== null,
        )
      ) {
        return false;
      }
      const now = new Date();
      await transaction
        .update(jobs)
        .set({ status: "blocked", updatedAt: now })
        .where(eq(jobs.runId, runId));
      await transaction
        .update(runs)
        .set({
          status: "blocked",
          currentStage: "planning",
          updatedAt: now,
          finishedAt: now,
        })
        .where(eq(runs.id, runId));
      const [sequenceRow] = await transaction
        .select({ sequence: max(runEvents.sequence) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId));
      const event: RunEventView = {
        runId,
        sequence: (sequenceRow?.sequence ?? -1) + 1,
        level: "error",
        stage: "planning",
        message: "制作任务计划未能完整持久化，Run 已安全阻断。",
        createdAtUtc: now.toISOString(),
      };
      await transaction.insert(runEvents).values({
        id: randomUUID(),
        runId,
        sequence: event.sequence,
        level: event.level,
        stage: event.stage,
        message: event.message,
        createdAt: now,
      });
      await transaction.insert(outboxEvents).values({
        id: randomUUID(),
        topic: "run.event",
        aggregateId: runId,
        payload: { ...event },
        createdAt: now,
      });
      return true;
    });
  }

  /**
   * 从持久化权威事件流按 sequence 分页恢复事件。
   * @param runId Run 标识。
   * @param query 已受 schema 限制的 afterSequence 和 limit。
   * @returns 大于 afterSequence、按 sequence 升序的有限 RunEventView 集合；不依赖 Socket 广播是否送达。
   */
  async events(runId: string, query: RunEventQuery): Promise<RunEventView[]> {
    const rows = await this.connection.database
      .select()
      .from(runEvents)
      .where(
        and(
          eq(runEvents.runId, runId),
          gt(runEvents.sequence, query.afterSequence),
        ),
      )
      .orderBy(asc(runEvents.sequence))
      .limit(query.limit);
    return rows.map((row) => ({
      runId: row.runId,
      sequence: row.sequence,
      level: row.level as RunEventView["level"],
      stage: row.stage,
      message: row.message,
      ...(row.evidenceArtifactId
        ? { evidenceArtifactId: row.evidenceArtifactId }
        : {}),
      createdAtUtc: row.createdAt.toISOString(),
    }));
  }
}

/**
 * 将 runs 数据库行映射为公开 ViewModel，并在读取边界重新验证不可提升安全状态。
 * @param row 已查询的 runs 行。
 * @returns 不包含 ownerUserId、idempotencyKey、请求指纹、Job payload 或凭据的 RunView。
 * @throws 当数据库安全状态违反 immutableSafetyStateSchema 时抛出，避免将损坏值静默回显为有效证明。
 */
function toRunView(row: typeof runs.$inferSelect): RunView {
  const safetyState = immutableSafetyStateSchema.parse({
    deploymentAuthorized: row.deploymentAuthorized,
    deploymentPerformed: row.deploymentPerformed,
    fullSkillCoverageProven: row.fullSkillCoverageProven,
    clientCompatibilityProven: row.clientCompatibilityProven,
  });
  return {
    id: row.id,
    projectId: row.projectId,
    snapshotId: row.snapshotId,
    clientRunId: row.clientRunId,
    action: row.action,
    status: row.status,
    currentStage: row.currentStage,
    requestSha256: row.requestSha256,
    serverConnectionEnabled: true,
    modelEgressAuthorized: row.modelEgressAuthorized,
    deploymentAuthorized: safetyState.deploymentAuthorized,
    deploymentPerformed: safetyState.deploymentPerformed,
    fullSkillCoverageProven: safetyState.fullSkillCoverageProven,
    clientCompatibilityProven: safetyState.clientCompatibilityProven,
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
    ...(row.finishedAt ? { finishedAtUtc: row.finishedAt.toISOString() } : {}),
  };
}
