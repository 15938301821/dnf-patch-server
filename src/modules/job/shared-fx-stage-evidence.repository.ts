/**
 * @fileoverview 持久化共享特效阶段 Artifact 证据及权威事件；不访问对象存储、执行工具或信任调用方哈希。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  artifactUploadSessions,
  sharedFxStageEvidences,
} from "../../common/db/artifact-schema.js";
import { artifacts, jobs, runs } from "../../common/db/schema.js";
import { validateLeaseMutation } from "./job-lease.js";
import {
  appendJobRunEvent,
  databaseNow,
} from "./job-run-event.repository-support.js";
import type {
  RecordSharedFxStageEvidenceInput,
  SharedFxStageEvidenceMutationResult,
  SharedFxStageEvidenceView,
} from "./shared-fx-stage-evidence.contracts.js";
import { sharedFxStageSchema } from "./shared-fx.contracts.js";

@Injectable()
export class SharedFxStageEvidenceRepository {
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 只允许当前 exact lease 把已 finalize 的同 Job Artifact 绑定到一个固定阶段。
   * 同阶段重复报告同一 Artifact 是幂等的；替换 Artifact 会被拒绝，保留首次证据的审计意义。
   */
  async record(
    jobId: string,
    input: RecordSharedFxStageEvidenceInput,
  ): Promise<SharedFxStageEvidenceMutationResult> {
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
      if (job.attemptCount !== input.attempt) {
        return { status: "lease-mismatch" };
      }
      if (job.kind !== "shared-fx") return { status: "job-kind-mismatch" };

      const [run] = await transaction
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, job.runId))
        .limit(1)
        .for("update");
      if (!run) throw new Error("SHARED_FX_EVIDENCE_RUN_INVARIANT_FAILED");

      const [existing] = await transaction
        .select()
        .from(sharedFxStageEvidences)
        .where(
          and(
            eq(sharedFxStageEvidences.jobId, jobId),
            eq(sharedFxStageEvidences.attempt, input.attempt),
            eq(sharedFxStageEvidences.stage, input.stage),
          ),
        )
        .limit(1)
        .for("update");
      if (existing) {
        return existing.artifactId === input.artifactId
          ? { status: "accepted", evidence: toEvidenceView(existing) }
          : { status: "stage-conflict" };
      }

      const [artifact] = await transaction
        .select({
          uploadId: artifactUploadSessions.id,
          uploadArtifactId: artifactUploadSessions.artifactId,
          finalizedAt: artifactUploadSessions.finalizedAt,
          sha256: artifacts.sha256,
        })
        .from(artifactUploadSessions)
        .innerJoin(
          artifacts,
          and(
            eq(artifacts.runId, artifactUploadSessions.runId),
            eq(artifacts.id, artifactUploadSessions.artifactId),
          ),
        )
        .where(
          and(
            eq(artifactUploadSessions.runId, job.runId),
            eq(artifactUploadSessions.jobId, jobId),
            eq(artifactUploadSessions.workerId, input.workerId),
            eq(artifactUploadSessions.leaseId, input.leaseId),
            eq(artifactUploadSessions.attempt, input.attempt),
            eq(artifactUploadSessions.artifactId, input.artifactId),
            eq(artifactUploadSessions.status, "finalized"),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !artifact ||
        artifact.uploadArtifactId !== input.artifactId ||
        artifact.finalizedAt === null
      ) {
        return { status: "artifact-not-finalized" };
      }

      const evidence: SharedFxStageEvidenceView = {
        jobId,
        stage: input.stage,
        artifactId: input.artifactId,
        artifactSha256: artifact.sha256.toUpperCase(),
        createdAtUtc: now.toISOString(),
      };
      await transaction.insert(sharedFxStageEvidences).values({
        id: randomUUID(),
        runId: job.runId,
        jobId,
        workerId: input.workerId,
        leaseId: input.leaseId,
        attempt: input.attempt,
        stage: input.stage,
        artifactId: input.artifactId,
        artifactSha256: evidence.artifactSha256,
        uploadId: artifact.uploadId,
        createdAt: now,
      });
      await appendJobRunEvent(
        transaction,
        job.runId,
        "info",
        `shared-fx.${input.stage}`,
        "共享特效阶段证据已封存。",
        now,
        input.artifactId,
      );
      return { status: "accepted", evidence };
    });
  }
}

function toEvidenceView(
  row: typeof sharedFxStageEvidences.$inferSelect,
): SharedFxStageEvidenceView {
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  return {
    jobId: row.jobId,
    stage: sharedFxStageSchema.parse(row.stage),
    artifactId: row.artifactId,
    artifactSha256: row.artifactSha256.toUpperCase(),
    createdAtUtc: createdAt.toISOString(),
  };
}
