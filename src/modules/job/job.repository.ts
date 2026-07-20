import { Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, lt, max, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  jobAttempts,
  jobs,
  outboxEvents,
  runEvents,
  runs,
  workers,
} from "../../common/db/schema.js";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";
import type { RunEventView } from "../run/run.contracts.js";
import type {
  ClaimJobInput,
  CompleteJobInput,
  JobView,
} from "./job.contracts.js";
import { aggregateRunStatus } from "./run-status.js";

interface ClaimJobResult {
  job: JobView;
  runEvent?: RunEventView;
}

interface CompleteJobResult {
  accepted: boolean;
  runEvent?: RunEventView;
}

@Injectable()
export class JobRepository {
  constructor(private readonly connection: DatabaseService) {}

  async claim(
    input: ClaimJobInput,
    leaseSeconds: number,
  ): Promise<ClaimJobResult | undefined> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
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
            lt(jobs.attemptCount, jobs.maxAttempts),
            or(
              eq(jobs.status, "queued"),
              and(
                eq(jobs.status, "leased"),
                or(isNull(jobs.leaseExpiresAt), lt(jobs.leaseExpiresAt, now)),
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
      const attempt = candidate.attemptCount + 1;
      await transaction
        .update(jobs)
        .set({
          status: "leased",
          leaseOwnerId: input.workerId,
          leaseExpiresAt,
          attemptCount: attempt,
          updatedAt: now,
        })
        .where(eq(jobs.id, candidate.id));
      await transaction.insert(jobAttempts).values({
        id: randomUUID(),
        jobId: candidate.id,
        workerId: input.workerId,
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
          leaseExpiresAt,
          attemptCount: attempt,
          updatedAt: now,
        }),
        ...(runEvent ? { runEvent } : {}),
      };
    });
  }

  async heartbeat(
    jobId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    const result = await this.connection.database
      .update(jobs)
      .set({ leaseExpiresAt, updatedAt: now })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, "leased"),
          eq(jobs.leaseOwnerId, workerId),
          gt(jobs.leaseExpiresAt, now),
        ),
      );
    return result[0].affectedRows === 1;
  }

  async complete(
    jobId: string,
    input: CompleteJobInput,
  ): Promise<CompleteJobResult> {
    const now = new Date();
    return this.connection.database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, "leased"),
            eq(jobs.leaseOwnerId, input.workerId),
            gt(jobs.leaseExpiresAt, now),
          ),
        )
        .limit(1)
        .for("update");
      if (!job) {
        return { accepted: false };
      }
      await transaction
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, job.runId))
        .limit(1)
        .for("update");
      await transaction
        .update(jobs)
        .set({
          status: input.status,
          leaseOwnerId: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));
      await transaction
        .update(jobAttempts)
        .set({
          status: input.status,
          finishedAt: now,
          ...(input.resultSha256
            ? { resultSha256: input.resultSha256.toUpperCase() }
            : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        })
        .where(
          and(
            eq(jobAttempts.jobId, jobId),
            eq(jobAttempts.attempt, job.attemptCount),
          ),
        );
      const runEvent = await finalizeRunIfComplete(
        transaction,
        job.runId,
        jobId,
        input.status,
        now,
      );
      return {
        accepted: true,
        ...(runEvent ? { runEvent } : {}),
      };
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
  return appendRunEvent(
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
  completedJobId: string,
  completedStatus: string,
  now: Date,
): Promise<RunEventView | undefined> {
  const rows = await transaction
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.runId, runId));
  const status = aggregateRunStatus(
    rows.map((row) =>
      row.id === completedJobId ? completedStatus : row.status,
    ),
  );
  if (!status) return undefined;
  await transaction
    .update(runs)
    .set({
      status,
      currentStage: status,
      updatedAt: now,
      finishedAt: now,
    })
    .where(eq(runs.id, runId));
  const level =
    status === "failed" ? "error" : status === "blocked" ? "warning" : "info";
  return appendRunEvent(
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

async function appendRunEvent(
  transaction: Transaction,
  runId: string,
  level: RunEventView["level"],
  stage: string,
  message: string,
  now: Date,
): Promise<RunEventView> {
  const [sequenceRow] = await transaction
    .select({ sequence: max(runEvents.sequence) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  const event: RunEventView = {
    runId,
    sequence: (sequenceRow?.sequence ?? -1) + 1,
    level,
    stage,
    message,
    createdAtUtc: now.toISOString(),
  };
  await transaction.insert(runEvents).values({
    id: randomUUID(),
    runId,
    sequence: event.sequence,
    level,
    stage,
    message,
    createdAt: now,
  });
  await transaction.insert(outboxEvents).values({
    id: randomUUID(),
    topic: "run.event",
    aggregateId: runId,
    payload: { ...event },
    createdAt: now,
  });
  return event;
}

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

function toJobView(row: typeof jobs.$inferSelect): JobView {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as JobView["kind"],
    status: row.status,
    payload: row.payload,
    payloadSha256: row.payloadSha256,
    ...(row.leaseOwnerId ? { leaseOwnerId: row.leaseOwnerId } : {}),
    ...(row.leaseExpiresAt
      ? { leaseExpiresAtUtc: row.leaseExpiresAt.toISOString() }
      : {}),
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
  };
}
