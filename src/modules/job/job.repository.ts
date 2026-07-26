/**
 * @fileoverview 在单一事务中领取、续租、完成和回收 Worker Job，并同步维护 attempt、Run 状态与权威事件/outbox；
 * 不处理 HTTP DTO、认证 token、本机执行、资源解析或 WebSocket 广播。
 * @module modules/job/repository
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 * 调用链：JobService 调用本类，所有事件经事务 outbox 在提交后由 Run dispatcher 广播；JobController 不直接访问它。
 * 副作用与边界：数据库时间、`FOR UPDATE SKIP LOCKED`、lease fencing、attempt 与 Run 聚合必须同事务完成；
 * 缺少 Worker/capability/Factory payload/lease/共享特效证据时 fail-closed，且本类不证明 Worker 工具或资源真实可用。
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  jobAttempts,
  jobs,
  projects,
  runs,
  workers,
  factories,
} from "../../common/db/schema.js";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";
import type { RunEventView } from "../run/run.contracts.js";
import { closeJobAttempt } from "./job-attempt-close.repository-support.js";
import type {
  ClaimJobInput,
  CompleteJobInput,
  HeartbeatJobInput,
  JobView,
} from "./job.contracts.js";
import {
  type LeaseMutationStatus,
  validateLeaseMutation,
} from "./job-lease.js";
import {
  appendJobRunEvent,
  databaseNow,
  ensurePendingSharedFxReview,
} from "./job-run-event.repository-support.js";
import { toJobView } from "./job.mapper.js";
import { validatePersistedJobIntegrity } from "./job-integrity.js";
import { findSharedFxCompletionEvidenceForJob } from "./shared-fx-completion.repository-support.js";
import {
  advanceProfessionPackageStage,
  prepareProfessionCompletion,
} from "./job-profession-completion.repository-support.js";
import {
  closeStylePackageForTerminalJob,
  prepareStylePackageCompletion,
} from "./job-style-package-completion.repository-support.js";
import {
  finalizeRunIfComplete,
  markRunRunning,
} from "./job-run-status.repository-support.js";
import {
  surrenderJobAttempt,
  type SurrenderJobResult,
} from "./job-surrender.repository-support.js";
import type { SurrenderJobInput } from "./job.contracts.js";

interface ClaimJobResult {
  job: JobView;
  runEvents: RunEventView[];
}
interface ClaimIntegrityFailure {
  integrityFailure: true;
  runEvents: RunEventView[];
}

interface CompleteJobResult {
  status:
    | LeaseMutationStatus
    | "profession-evidence-incomplete"
    | "style-package-evidence-incomplete"
    | "shared-fx-evidence-incomplete"
    | "shared-fx-review-conflict";
  runEvent?: RunEventView;
}

/** Job 生命周期的持久化边界；每个 mutation 方法都在自身事务内建立锁、时间和事件一致性。 */
@Injectable()
export class JobRepository {
  constructor(private readonly connection: DatabaseService) {}

  /** 原子选择兼容 Worker 的最早可派发 Job，验证持久化 Factory 契约后签发新 attempt/lease 并写入 Run 事件。 */
  async claim(
    input: ClaimJobInput,
    leaseSeconds: number,
  ): Promise<ClaimJobResult | ClaimIntegrityFailure | undefined> {
    return this.connection.database.transaction(async (transaction) => {
      const [worker] = await transaction
        .select()
        .from(workers)
        .where(and(eq(workers.id, input.workerId), eq(workers.disabled, false)))
        .limit(1)
        .for("update");
      if (!worker) {
        return undefined;
      }
      const capabilities = allowedJobKindSchema
        .array()
        .parse(worker.capabilities);
      const [candidate] = await transaction
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.kind, capabilities),
            sql`${jobs.dispatchReadyAt} <= CURRENT_TIMESTAMP(3)`,
            lt(jobs.attemptCount, jobs.maxAttempts),
            or(
              eq(jobs.status, "queued"),
              and(
                eq(jobs.status, "leased"),
                or(
                  isNull(jobs.leaseExpiresAt),
                  lt(jobs.leaseExpiresAt, sql`CURRENT_TIMESTAMP(3)`),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) {
        return undefined;
      }
      const [run] = await transaction
        .select()
        .from(runs)
        .where(eq(runs.id, candidate.runId))
        .limit(1)
        .for("update");
      const [project] = run
        ? await transaction
            .select()
            .from(projects)
            .where(eq(projects.id, run.projectId))
            .limit(1)
        : [];
      const [factory] = project
        ? await transaction
            .select()
            .from(factories)
            .where(eq(factories.id, project.factoryId))
            .limit(1)
        : [];
      if (
        !run ||
        !project ||
        !factory ||
        !validatePersistedJobIntegrity({
          kind: candidate.kind,
          payload: candidate.payload,
          payloadSha256: candidate.payloadSha256,
          factoryConfig: factory.config,
          factoryConfigSha256: factory.configSha256,
        })
      ) {
        const now = await databaseNow(transaction);
        if (candidate.status === "leased") {
          await closeJobAttempt(
            transaction,
            candidate,
            now,
            "blocked",
            "JOB_INTEGRITY_FAILED",
          );
        }
        await transaction
          .update(jobs)
          .set({
            status: "blocked",
            leaseOwnerId: null,
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(jobs.id, candidate.id));
        const runEvents: RunEventView[] = [];
        if (run) {
          await advanceProfessionPackageStage(
            transaction,
            candidate,
            "blocked",
            now,
          );
          await closeStylePackageForTerminalJob(
            transaction,
            candidate,
            "blocked",
            now,
          );
          runEvents.push(
            await appendJobRunEvent(
              transaction,
              candidate.runId,
              "warning",
              "integrity",
              "Job 持久化数据完整性校验失败，已隔离并阻断下发。",
              now,
            ),
          );
          const terminalEvent = await finalizeRunIfComplete(
            transaction,
            candidate.runId,
            now,
          );
          if (terminalEvent) runEvents.push(terminalEvent);
        }
        return { integrityFailure: true, runEvents };
      }
      const now = await databaseNow(transaction);
      const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
      if (candidate.status === "leased") {
        await closeJobAttempt(
          transaction,
          candidate,
          now,
          "timed_out",
          "LEASE_EXPIRED",
        );
      }
      const attempt = candidate.attemptCount + 1;
      const leaseId = randomUUID();
      await transaction
        .update(jobs)
        .set({
          status: "leased",
          leaseOwnerId: input.workerId,
          leaseId,
          leaseExpiresAt,
          attemptCount: attempt,
          updatedAt: now,
        })
        .where(eq(jobs.id, candidate.id));
      await transaction.insert(jobAttempts).values({
        id: randomUUID(),
        jobId: candidate.id,
        workerId: input.workerId,
        leaseId,
        attempt,
        status: "running",
        startedAt: now,
      });
      await transaction
        .update(workers)
        .set({ lastHeartbeatAt: now })
        .where(eq(workers.id, input.workerId));
      const runEvent = await markRunRunning(transaction, candidate.runId, now);
      return {
        job: toJobView({
          ...candidate,
          status: "leased",
          leaseOwnerId: input.workerId,
          leaseId,
          leaseExpiresAt,
          attemptCount: attempt,
          updatedAt: now,
        }),
        runEvents: runEvent ? [runEvent] : [],
      };
    });
  }

  /** 仅在锁定 Job 的 owner、当前 fencing token 和数据库时钟仍完全匹配时延长 lease 并刷新 Worker 心跳。 */
  async heartbeat(
    jobId: string,
    input: HeartbeatJobInput,
    leaseSeconds: number,
  ): Promise<LeaseMutationStatus> {
    return this.connection.database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!job) return "lease-mismatch";
      const now = await databaseNow(transaction);
      const status = validateLeaseMutation(job, input, now);
      if (status !== "accepted") return status;
      const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
      await transaction
        .update(jobs)
        .set({ leaseExpiresAt, updatedAt: now })
        .where(eq(jobs.id, jobId));
      await transaction
        .update(workers)
        .set({ lastHeartbeatAt: now })
        .where(eq(workers.id, input.workerId));
      return "accepted";
    });
  }

  /** 以当前 fencing token 显式关闭瞬时失败 attempt，并委托事务 helper 重排或终结。 */
  surrender(
    jobId: string,
    input: SurrenderJobInput,
  ): Promise<SurrenderJobResult> {
    return surrenderJobAttempt(this.connection, jobId, input);
  }

  /** 以精确 lease 完成当前 attempt，必要时验证共享特效证据/审核并在全部 Job 终态后原子终结 Run。 */
  async complete(
    jobId: string,
    input: CompleteJobInput,
  ): Promise<CompleteJobResult> {
    return this.connection.database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!job) return { status: "lease-mismatch" };
      const now = await databaseNow(transaction);
      const leaseStatus = validateLeaseMutation(job, input, now);
      if (leaseStatus !== "accepted") return { status: leaseStatus };
      await transaction
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, job.runId))
        .limit(1)
        .for("update");
      const sharedFxCompletion =
        job.kind === "shared-fx" && input.status === "passed"
          ? await findSharedFxCompletionEvidenceForJob(
              transaction,
              job,
              input.resultSha256,
            )
          : undefined;
      if (
        job.kind === "shared-fx" &&
        input.status === "passed" &&
        !sharedFxCompletion
      ) {
        return { status: "shared-fx-evidence-incomplete" };
      }
      if (sharedFxCompletion) {
        const review = await ensurePendingSharedFxReview(
          transaction,
          job.runId,
          sharedFxCompletion.independentValidationArtifactId,
          now,
        );
        if (review !== "accepted") {
          return { status: "shared-fx-review-conflict" };
        }
      }
      const professionCompletion = await prepareProfessionCompletion(
        transaction,
        job,
        input,
        now,
      );
      if (professionCompletion.status === "evidence-incomplete") {
        return { status: "profession-evidence-incomplete" };
      }
      const stylePackageCompletion = await prepareStylePackageCompletion(
        transaction,
        job,
        input,
        now,
      );
      if (stylePackageCompletion.status === "evidence-incomplete") {
        return { status: "style-package-evidence-incomplete" };
      }
      const resultSha256 =
        sharedFxCompletion?.independentValidationSha256 ??
        stylePackageCompletion.resultSha256 ??
        professionCompletion.resultSha256 ??
        input.resultSha256?.toUpperCase();
      await transaction
        .update(jobs)
        .set({
          status: input.status,
          leaseOwnerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));
      await transaction
        .update(jobAttempts)
        .set({
          status: input.status,
          finishedAt: now,
          ...(resultSha256 ? { resultSha256 } : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        })
        .where(
          and(
            eq(jobAttempts.jobId, jobId),
            eq(jobAttempts.attempt, job.attemptCount),
          ),
        );
      await advanceProfessionPackageStage(transaction, job, input.status, now);
      if (sharedFxCompletion) {
        await appendJobRunEvent(
          transaction,
          job.runId,
          "info",
          "manual-review",
          "共享特效 Worker 阶段已通过，等待人工审核。",
          now,
          sharedFxCompletion.independentValidationArtifactId,
        );
      }
      const runEvent = await finalizeRunIfComplete(transaction, job.runId, now);
      return {
        status: "accepted",
        ...(runEvent ? { runEvent } : {}),
      };
    });
  }

  /** 批量锁定并回收过期 lease；未耗尽 Job 重排，耗尽 Job 失败并尝试安全聚合 Run。 */
  async reapExpired(batchSize: number): Promise<RunEventView[]> {
    return this.connection.database.transaction(async (transaction) => {
      const expired = await transaction
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "leased"),
            or(
              isNull(jobs.leaseExpiresAt),
              lt(jobs.leaseExpiresAt, sql`CURRENT_TIMESTAMP(3)`),
            ),
          ),
        )
        .orderBy(asc(jobs.leaseExpiresAt), asc(jobs.createdAt))
        .limit(batchSize)
        .for("update", { skipLocked: true });
      if (expired.length === 0) return [];
      const now = await databaseNow(transaction);
      const events: RunEventView[] = [];
      for (const job of expired) {
        await closeJobAttempt(
          transaction,
          job,
          now,
          "timed_out",
          "LEASE_EXPIRED",
        );
        const exhausted = job.attemptCount >= job.maxAttempts;
        await transaction
          .update(jobs)
          .set({
            status: exhausted ? "failed" : "queued",
            leaseOwnerId: null,
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(jobs.id, job.id));
        if (!exhausted) continue;
        await transaction
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.id, job.runId))
          .limit(1)
          .for("update");
        await advanceProfessionPackageStage(transaction, job, "failed", now);
        await closeStylePackageForTerminalJob(transaction, job, "failed", now);
        const event = await finalizeRunIfComplete(transaction, job.runId, now);
        if (event) events.push(event);
      }
      return events;
    });
  }
}
