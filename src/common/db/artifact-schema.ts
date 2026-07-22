/**
 * @fileoverview 定义 Artifact 上传会话与共享特效阶段证据持久化表；不保存对象正文或执行存储操作。
 * @module database
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  foreignKey,
  index,
  int,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { artifacts, jobAttempts, jobs, runs, workers } from "./schema.js";

const id = (name: string) => varchar(name, { length: 64 });
const sha256 = (name: string) => varchar(name, { length: 64 });
const utc = (name: string) => datetime(name, { mode: "date", fsp: 3 });

export const artifactUploadSessions = mysqlTable(
  "artifact_upload_sessions",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    jobId: id("job_id").notNull(),
    workerId: id("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    leaseId: id("lease_id").notNull(),
    attempt: int("attempt", { unsigned: true }).notNull(),
    objectKey: varchar("object_key", { length: 500 }).notNull(),
    logicalName: varchar("logical_name", { length: 200 }).notNull(),
    mediaType: varchar("media_type", { length: 120 }).notNull(),
    expectedByteLength: int("expected_byte_length", {
      unsigned: true,
    }).notNull(),
    expectedSha256: sha256("expected_sha256").notNull(),
    provenance: json("provenance").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    artifactId: id("artifact_id"),
    errorCode: varchar("error_code", { length: 80 }),
    expiresAt: utc("expires_at").notNull(),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    finalizedAt: utc("finalized_at"),
    objectDeletedAt: utc("object_deleted_at"),
  },
  (table) => [
    index("artifact_upload_sessions_run_status_idx").on(
      table.runId,
      table.status,
      table.expiresAt,
    ),
    index("artifact_upload_sessions_orphan_idx").on(
      table.objectDeletedAt,
      table.status,
      table.expiresAt,
    ),
    uniqueIndex("artifact_upload_sessions_object_key_uq").on(table.objectKey),
    uniqueIndex("artifact_upload_sessions_artifact_uq").on(table.artifactId),
    uniqueIndex("artifact_upload_sessions_evidence_binding_uq").on(
      table.id,
      table.runId,
      table.jobId,
      table.workerId,
      table.leaseId,
      table.attempt,
      table.artifactId,
    ),
    foreignKey({
      columns: [table.runId, table.jobId],
      foreignColumns: [jobs.runId, jobs.id],
      name: "artifact_upload_sessions_job_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.jobId, table.attempt, table.workerId, table.leaseId],
      foreignColumns: [
        jobAttempts.jobId,
        jobAttempts.attempt,
        jobAttempts.workerId,
        jobAttempts.leaseId,
      ],
      name: "artifact_upload_sessions_attempt_lease_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.artifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "artifact_upload_sessions_artifact_run_fk",
    }).onDelete("restrict"),
    check(
      "artifact_upload_sessions_status_ck",
      sql`${table.status} in ('authorized', 'finalized', 'rejected')`,
    ),
    check(
      "artifact_upload_sessions_state_ck",
      sql`(${table.status} = 'authorized' and ${table.artifactId} is null and ${table.errorCode} is null and ${table.finalizedAt} is null and ${table.objectDeletedAt} is null) or (${table.status} = 'finalized' and ${table.artifactId} is not null and ${table.errorCode} is null and ${table.finalizedAt} is not null and ${table.objectDeletedAt} is null) or (${table.status} = 'rejected' and ${table.artifactId} is null and ${table.errorCode} is not null and ${table.finalizedAt} is null)`,
    ),
    check(
      "artifact_upload_sessions_expiry_ck",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "artifact_upload_sessions_object_key_ck",
      sql`${table.objectKey} like 'artifacts/%'`,
    ),
  ],
);

/**
 * 共享特效的阶段证据只引用经服务器复核并 finalize 的上传会话。
 * 复合外键保留 Job、attempt、Worker、lease 和 Artifact 的完整归属链，避免仅凭 Artifact ID 声明阶段已完成。
 */
export const sharedFxStageEvidences = mysqlTable(
  "shared_fx_stage_evidences",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    jobId: id("job_id").notNull(),
    workerId: id("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    leaseId: id("lease_id").notNull(),
    attempt: int("attempt", { unsigned: true }).notNull(),
    stage: varchar("stage", { length: 32 }).notNull(),
    artifactId: id("artifact_id").notNull(),
    artifactSha256: sha256("artifact_sha256").notNull(),
    uploadId: id("upload_id").notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    index("shared_fx_stage_evidences_job_attempt_idx").on(
      table.jobId,
      table.attempt,
    ),
    uniqueIndex("shared_fx_stage_evidences_stage_uq").on(
      table.jobId,
      table.attempt,
      table.stage,
    ),
    foreignKey({
      columns: [table.runId, table.jobId],
      foreignColumns: [jobs.runId, jobs.id],
      name: "shared_fx_stage_evidences_job_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.jobId, table.attempt, table.workerId, table.leaseId],
      foreignColumns: [
        jobAttempts.jobId,
        jobAttempts.attempt,
        jobAttempts.workerId,
        jobAttempts.leaseId,
      ],
      name: "shared_fx_stage_evidences_attempt_lease_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.artifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "shared_fx_stage_evidences_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.uploadId,
        table.runId,
        table.jobId,
        table.workerId,
        table.leaseId,
        table.attempt,
        table.artifactId,
      ],
      foreignColumns: [
        artifactUploadSessions.id,
        artifactUploadSessions.runId,
        artifactUploadSessions.jobId,
        artifactUploadSessions.workerId,
        artifactUploadSessions.leaseId,
        artifactUploadSessions.attempt,
        artifactUploadSessions.artifactId,
      ],
      name: "shared_fx_stage_evidences_upload_binding_fk",
    }).onDelete("restrict"),
    check(
      "shared_fx_stage_evidences_stage_ck",
      sql`${table.stage} in ('inventory', 'material', 'aseprite', 'runtime', 'npk', 'independent-validation')`,
    ),
  ],
);
