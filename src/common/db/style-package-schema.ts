/**
 * @fileoverview 定义风格 Run 的候选包聚合表；不保存候选 NPK 正文、不授权部署，也不证明
 * 客户端兼容。对象正文仍位于私有对象存储，数据库只保存同 Run Artifact 引用和摘要。
 * @module common/db/style-package-schema
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：PatchTask Repository 在 transaction 中创建和更新，DatabaseService 与 drizzle-kit
 * 将本文件并入统一 schema；审核与下载流程只消费 passed 记录的证据引用。
 * 输入输出：输入已校验的职业/风格/Run/Artifact 标识与状态，输出仅为内部数据库行。
 * 安全边界：passed 必须具备同 Run package Artifact、manifest SHA-256 与 finishedAt；限制性外键
 * 不能放宽，候选包存在不能提升 deploymentAuthorized 或 clientCompatibilityProven。
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
import { artifactUploadSessions } from "./artifact-schema.js";
import { artifacts, jobAttempts, jobs, runs, workers } from "./schema.js";
import { professionStyles } from "./studio-schema.js";

/**
 * 风格 Run 的候选包聚合状态；passed 只证明候选对象与清单证据已记录，不代表部署或兼容。
 */
export const stylePackages = mysqlTable(
  "style_packages",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    professionId: varchar("profession_id", { length: 64 }).notNull(),
    styleId: varchar("style_id", { length: 64 }).notNull(),
    runId: varchar("run_id", { length: 64 })
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    /** 同一 runId 下的候选包 Artifact，只有 passed 时要求非空。 */
    packageArtifactId: varchar("package_artifact_id", { length: 64 }),
    manifestSha256: varchar("manifest_sha256", { length: 64 }),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
    finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
  },
  (table) => [
    index("style_packages_style_idx").on(table.styleId),
    uniqueIndex("style_packages_run_uq").on(table.runId),
    check(
      "style_packages_status_ck",
      sql`${table.status} in ('queued', 'building', 'passed', 'failed', 'blocked')`,
    ),
    check(
      "style_packages_passed_evidence_ck",
      sql`${table.status} <> 'passed' or (${table.packageArtifactId} is not null and ${table.manifestSha256} is not null and ${table.finishedAt} is not null)`,
    ),
    foreignKey({
      columns: [table.professionId, table.styleId],
      foreignColumns: [professionStyles.professionId, professionStyles.id],
      name: "style_packages_style_profession_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.packageArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_packages_artifact_run_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * Package V3 单次 attempt 的封存证据；生产方是 npk-package Worker 报告接收事务，消费方是
 * Job complete 前置校验。它比 style_packages 聚合表更细，保留三份输出 Artifact 与对应上传会话，
 * 但仍不保存候选 NPK、manifest 或验证 JSON 正文。
 */
export const stylePackageAttemptEvidences = mysqlTable(
  "style_package_attempt_evidences",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    runId: varchar("run_id", { length: 64 }).notNull(),
    stylePackageId: varchar("style_package_id", { length: 64 }).notNull(),
    jobId: varchar("job_id", { length: 64 }).notNull(),
    workerId: varchar("worker_id", { length: 64 }).notNull(),
    leaseId: varchar("lease_id", { length: 64 }).notNull(),
    attempt: int("attempt", { unsigned: true }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    packageContextSha256: varchar("package_context_sha256", {
      length: 64,
    }).notNull(),
    packageProfileSha256: varchar("package_profile_sha256", {
      length: 64,
    }).notNull(),
    packageArtifactId: varchar("package_artifact_id", { length: 64 }),
    packageSha256: varchar("package_sha256", { length: 64 }),
    packageUploadId: varchar("package_upload_id", { length: 64 }),
    manifestArtifactId: varchar("manifest_artifact_id", { length: 64 }),
    manifestSha256: varchar("manifest_sha256", { length: 64 }),
    manifestUploadId: varchar("manifest_upload_id", { length: 64 }),
    validationArtifactId: varchar("validation_artifact_id", { length: 64 }),
    validationSha256: varchar("validation_sha256", { length: 64 }),
    validationUploadId: varchar("validation_upload_id", { length: 64 }),
    safety: json("safety").$type<Record<string, unknown>>().notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
    finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
  },
  (table) => [
    index("style_package_attempt_evidences_package_idx").on(
      table.stylePackageId,
    ),
    uniqueIndex("style_package_attempt_evidences_attempt_uq").on(
      table.jobId,
      table.attempt,
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runs.id],
      name: "spae_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.stylePackageId],
      foreignColumns: [stylePackages.id],
      name: "spae_package_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.workerId],
      foreignColumns: [workers.id],
      name: "spae_worker_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.jobId],
      foreignColumns: [jobs.runId, jobs.id],
      name: "style_package_attempt_evidences_job_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.jobId, table.attempt, table.workerId, table.leaseId],
      foreignColumns: [
        jobAttempts.jobId,
        jobAttempts.attempt,
        jobAttempts.workerId,
        jobAttempts.leaseId,
      ],
      name: "style_package_attempt_evidences_attempt_lease_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.packageArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_package_attempt_evidences_package_artifact_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.manifestArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_package_attempt_evidences_manifest_artifact_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.validationArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_package_attempt_evidences_validation_artifact_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.packageUploadId,
        table.runId,
        table.jobId,
        table.workerId,
        table.leaseId,
        table.attempt,
        table.packageArtifactId,
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
      name: "style_package_attempt_evidences_package_upload_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.manifestUploadId,
        table.runId,
        table.jobId,
        table.workerId,
        table.leaseId,
        table.attempt,
        table.manifestArtifactId,
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
      name: "style_package_attempt_evidences_manifest_upload_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.validationUploadId,
        table.runId,
        table.jobId,
        table.workerId,
        table.leaseId,
        table.attempt,
        table.validationArtifactId,
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
      name: "style_package_attempt_evidences_validation_upload_fk",
    }).onDelete("restrict"),
    check(
      "style_package_attempt_evidences_status_ck",
      sql`${table.status} in ('building', 'passed', 'failed', 'blocked')`,
    ),
    check(
      "style_package_attempt_evidences_passed_ck",
      sql`${table.status} <> 'passed' or (${table.packageArtifactId} is not null and ${table.packageSha256} is not null and ${table.packageUploadId} is not null and ${table.manifestArtifactId} is not null and ${table.manifestSha256} is not null and ${table.manifestUploadId} is not null and ${table.validationArtifactId} is not null and ${table.validationSha256} is not null and ${table.validationUploadId} is not null and ${table.errorCode} is null and ${table.finishedAt} is not null)`,
    ),
    check(
      "style_package_attempt_evidences_terminal_error_ck",
      sql`${table.status} not in ('failed', 'blocked') or (${table.errorCode} is not null and ${table.finishedAt} is not null)`,
    ),
    check(
      "style_package_attempt_evidences_non_passed_ck",
      sql`${table.status} = 'passed' or (${table.packageArtifactId} is null and ${table.packageSha256} is null and ${table.packageUploadId} is null and ${table.manifestArtifactId} is null and ${table.manifestSha256} is null and ${table.manifestUploadId} is null and ${table.validationArtifactId} is null and ${table.validationSha256} is null and ${table.validationUploadId} is null)`,
    ),
  ],
);
