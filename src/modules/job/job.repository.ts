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
  type JobTransaction,
} from "./job-run-event.repository-support.js";
import { toJobView } from "./job.mapper.js";
import { aggregateRunStatus } from "./run-status.js";
import { validatePersistedJobIntegrity } from "./job-integrity.js";
import { findSharedFxCompletionEvidenceForJob } from "./shared-fx-completion.repository-support.js";

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
    | "shared-fx-evidence-incomplete"
    | "shared-fx-review-conflict";
  runEvent?: RunEventView;
}

@Injectable()
export class JobRepository {
  constructor(private readonly connection: DatabaseService) {}

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
            sql`${jobs.dispatchReadyAt} is not null`,
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
          await closeIntegrityFailedAttempt(transaction, candidate, now);
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
        await closeExpiredAttempt(transaction, candidate, now);
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
      const resultSha256 =
        sharedFxCompletion?.independentValidationSha256 ??
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

  /** 回收过期租约；未耗尽任务重新排队，耗尽任务失败并尝试终结 Run。 */
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
        await closeExpiredAttempt(transaction, job, now);
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
        const event = await finalizeRunIfComplete(transaction, job.runId, now);
        if (event) events.push(event);
      }
      return events;
    });
  }
}

async function markRunRunning(
  transaction: Transaction,
  runId: string,
  now: Date,
): Promise<RunEventView | undefined> {
  const result = await transaction
    .update(runs)
    .set({ status: "running", currentStage: "worker", updatedAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")));
  if (result[0].affectedRows !== 1) return undefined;
  return appendJobRunEvent(
    transaction,
    runId,
    "info",
    "worker",
    "Worker 已领取首个任务，Run 进入执行状态。",
    now,
  );
}

async function finalizeRunIfComplete(
  transaction: Transaction,
  runId: string,
  now: Date,
): Promise<RunEventView | undefined> {
  const rows = await transaction
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.runId, runId));
  const status = aggregateRunStatus(rows.map((row) => row.status));
  if (!status) return undefined;
  const updateResult = await transaction
    .update(runs)
    .set({
      status,
      currentStage: status,
      updatedAt: now,
      finishedAt: now,
    })
    .where(
      and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])),
    );
  if (updateResult[0].affectedRows !== 1) return undefined;
  const level =
    status === "failed" ? "error" : status === "blocked" ? "warning" : "info";
  return appendJobRunEvent(
    transaction,
    runId,
    level,
    status,
    status === "passed"
      ? "Run 的全部 Worker 任务已通过。"
      : status === "blocked"
        ? "Run 的 Worker 任务已完成，但至少一个任务被阻断。"
        : "Run 的 Worker 任务已完成，但至少一个任务失败。",
    now,
  );
}

type Transaction = JobTransaction;

async function closeExpiredAttempt(
  transaction: Transaction,
  job: typeof jobs.$inferSelect,
  now: Date,
): Promise<void> {
  if (job.attemptCount === 0) return;
  await transaction
    .update(jobAttempts)
    .set({
      status: "timed_out",
      errorCode: "LEASE_EXPIRED",
      finishedAt: now,
    })
    .where(
      and(
        eq(jobAttempts.jobId, job.id),
        eq(jobAttempts.attempt, job.attemptCount),
        eq(jobAttempts.status, "running"),
      ),
    );
}

async function closeIntegrityFailedAttempt(
  transaction: Transaction,
  job: typeof jobs.$inferSelect,
  now: Date,
): Promise<void> {
  if (job.attemptCount === 0) return;
  await transaction
    .update(jobAttempts)
    .set({
      status: "blocked",
      errorCode: "JOB_INTEGRITY_FAILED",
      finishedAt: now,
    })
    .where(
      and(
        eq(jobAttempts.jobId, job.id),
        eq(jobAttempts.attempt, job.attemptCount),
        eq(jobAttempts.status, "running"),
      ),
    );
}
