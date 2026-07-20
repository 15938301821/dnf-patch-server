import { Injectable } from "@nestjs/common";
import { and, asc, eq, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
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
  RunEventQuery,
  RunEventView,
  RunView,
} from "./run.contracts.js";

export interface CreateRunTransactionResult {
  run: RunView;
  jobs: JobView[];
  event: RunEventView;
}

@Injectable()
export class RunRepository {
  constructor(private readonly connection: DatabaseService) {}

  async findById(id: string): Promise<RunView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(runs)
      .where(eq(runs.id, id))
      .limit(1);
    return row ? toRunView(row) : undefined;
  }

  async findByIdempotency(
    projectId: string,
    idempotencyKey: string,
  ): Promise<RunView | undefined> {
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
    return row ? toRunView(row) : undefined;
  }

  async create(
    input: CreateRunInput,
    idempotencyKey: string,
    id: string,
    decisions: GuardrailEvaluation[],
  ): Promise<CreateRunTransactionResult> {
    const now = new Date();
    const blocked = decisions.some((decision) => decision.decision === "deny");
    return this.connection.database.transaction(async (transaction) => {
      await transaction.insert(runs).values({
        id,
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        clientRunId: input.clientRunId,
        idempotencyKey,
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
        createdAt: now,
        updatedAt: now,
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
        },
        jobs: jobViews,
        event,
      };
    });
  }

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

function toRunView(row: typeof runs.$inferSelect): RunView {
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
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
    ...(row.finishedAt ? { finishedAtUtc: row.finishedAt.toISOString() } : {}),
  };
}
