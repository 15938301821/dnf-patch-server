/**
 * @fileoverview 定义 Artifact 上传会话与共享特效阶段证据持久化表；不保存对象正文或执行存储操作。
 * @module database
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：Artifact Repository 在 transaction 中读写上传会话，阶段证据 Repository 只引用已
 * finalize 会话；Drizzle migration 从这些定义生成 SQL。输入是 Service 已校验的 Job/Worker
 * 租约、对象声明与服务端复核结果，输出是模块内部数据库行。副作用由调用方事务执行。
 * 安全边界：MySQL 不保存对象正文；复合外键必须同时绑定 Run、Job、Worker、leaseId、attempt
 * 与 Artifact，防止旧租约或跨 Run 证据写入。限制性外键和状态 CHECK 不得放宽。
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

/**
 * 上传授权到 finalize/reject 的权威会话表。
 *
 * 生产方是 Artifact Repository：`objectKey/mediaType/expectedByteLength/expectedSha256` 在授权时
 * 冻结，`artifactId/finalizedAt` 只在服务端完整复核成功后写入。消费方是 finalize、下载授权和
 * orphan reaper。`workerId + leaseId + attempt` 必须属于同一 Job 执行轮次；状态、错误、Artifact
 * 与删除时间由 CHECK 保持互斥，finalized 只证明对象长度/哈希，不证明补丁兼容或已部署。
 */
export const artifactUploadSessions = mysqlTable(
  "artifact_upload_sessions",
  {
    id: id("id").primaryKey(),
    /** producing Run；与 jobId、artifactId 通过复合外键保持同一 Run。 */
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    /** 产生对象的声明式 Job；必须与 runId 和 attempt 证据一致。 */
    jobId: id("job_id").notNull(),
    /** 已认证并持有当前租约的 Worker；不是任意请求 displayName。 */
    workerId: id("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    /** 当前 attempt 的 fencing 编号，阻止旧 Worker 写入重领后的 Job。 */
    leaseId: id("lease_id").notNull(),
    /** Job 第几次领取，与 leaseId、workerId 组成同一执行证据。 */
    attempt: int("attempt", { unsigned: true }).notNull(),
    /** 固定私有 bucket 内的相对 key；正文不进入 MySQL。 */
    objectKey: varchar("object_key", { length: 500 }).notNull(),
    logicalName: varchar("logical_name", { length: 200 }).notNull(),
    mediaType: varchar("media_type", { length: 120 }).notNull(),
    expectedByteLength: int("expected_byte_length", {
      unsigned: true,
    }).notNull(),
    /** 授权时冻结、finalize 时由服务端重算比较的大写 SHA-256。 */
    expectedSha256: sha256("expected_sha256").notNull(),
    /** 有界来源 JSON；Repository 写前、读后都必须通过对应运行时 schema。 */
    provenance: json("provenance").$type<Record<string, unknown>>().notNull(),
    /** authorized/finalized/rejected；与 artifactId/errorCode/finalizedAt 受组合 CHECK 约束。 */
    status: varchar("status", { length: 32 }).notNull(),
    /** 仅 finalized 状态可写，且必须与会话 runId 指向同一 Artifact。 */
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
 * 生产方是阶段完成 Service，消费方是后续流水线与审计查询；stage 唯一性只证明同一 attempt
 * 对该阶段记录一份证据，不扩大为完整 Run 通过、全技能覆盖或客户端兼容证明。
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
    /** 固定阶段枚举，由 Worker 声明式结果 schema 生产，不能接收任意工具步骤名。 */
    stage: varchar("stage", { length: 32 }).notNull(),
    /** 同一 Run 内已 finalize 的证据 Artifact；摘要需与该 Artifact 元数据一致。 */
    artifactId: id("artifact_id").notNull(),
    artifactSha256: sha256("artifact_sha256").notNull(),
    /** 绑定产生 artifactId 的上传会话，复合外键保留完整租约链。 */
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
