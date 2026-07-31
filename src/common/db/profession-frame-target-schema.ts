/**
 * @fileoverview 定义 Profession V6 从官方 target manifest 冻结的逐帧事实表；不保存图片正文、
 * 模型执行状态、Provider 参数或本机路径，也不执行查询或 migration。
 * @module common/db/profession-frame-target-schema
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：Job 模块的 target prepare Repository 在事务中写入本表，逐帧模型执行与 Worker 进度
 * 查询只读消费；DatabaseService 合并 schema，drizzle-kit 据此生成 migration。输入来自 Server 已完整
 * 复读并严格解析的 target manifest，输出是内部数据库行，不是 Worker DTO 或浏览器 ViewModel。
 * 副作用只由调用方 transaction（要么全部提交、要么全部回滚的数据库操作）产生。
 * 安全边界：Artifact 与 finalized upload session 的复合外键保留同一 Run/Job/Worker/lease/attempt
 * 归属；唯一键阻止重复帧；CHECK 固定生成、Hidden 和 LINK 的互斥证据。表中事实不能授权模型出站、
 * 部署或把客户端兼容状态提升为 true。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  datetime,
  foreignKey,
  index,
  int,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { artifactUploadSessions } from "./artifact-schema.js";
import { artifacts, jobAttempts, jobs, runs, workers } from "./schema.js";
import { styleSkillProductions } from "./studio-schema.js";

const id = (name: string) => varchar(name, { length: 64 });
const sha256 = (name: string) => varchar(name, { length: 64 });
const utc = (name: string) => datetime(name, { mode: "date", fsp: 3 });

/**
 * 一个 Profession Job attempt 的不可变官方帧目标。
 *
 * `frameOrdinal` 覆盖清单中的全部生成/Hidden/LINK 帧，供恢复时稳定分页；`generationOrdinal` 只在
 * `generate-same-size` 行存在，供模型执行按有界顺序调度。LINK 行通过同表外键复用同 entry 的目标，
 * 不能指向另一技能、attempt 或 IMG entry。
 */
export const professionSkillFrameTargets = mysqlTable(
  "profession_skill_frame_targets",
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
    skillId: id("skill_id").notNull(),
    /** 当前 attempt 上传并经 Server finalize/复读的 target manifest。 */
    manifestArtifactId: id("manifest_artifact_id").notNull(),
    manifestUploadId: id("manifest_upload_id").notNull(),
    manifestSha256: sha256("manifest_sha256").notNull(),
    /** 官方源 NPK 与 Inventory frame manifest 身份，逐行保留便于后续独立审计。 */
    sourceRunId: id("source_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    sourceFrameManifestArtifactId: id(
      "source_frame_manifest_artifact_id",
    ).notNull(),
    sourceFrameManifestSha256: sha256("source_frame_manifest_sha256").notNull(),
    sourceSha256: sha256("source_sha256").notNull(),
    /** 全清单稳定顺序，从 0 开始；连续性由 prepare Repository 在同一事务复核。 */
    frameOrdinal: int("frame_ordinal", { unsigned: true }).notNull(),
    /** 仅模型目标拥有，从 0 开始；Hidden/LINK 保持 null。 */
    generationOrdinal: int("generation_ordinal", { unsigned: true }),
    entryIndex: int("entry_index", { unsigned: true }).notNull(),
    frameIndex: int("frame_index", { unsigned: true }).notNull(),
    internalPath: varchar("internal_path", { length: 500 }).notNull(),
    imgVersion: int("img_version", { unsigned: true }).notNull(),
    frameType: varchar("frame_type", { length: 40 }).notNull(),
    compressMode: varchar("compress_mode", { length: 40 }).notNull(),
    hidden: boolean("hidden").notNull(),
    width: int("width", { unsigned: true }).notNull(),
    height: int("height", { unsigned: true }).notNull(),
    canvasWidth: int("canvas_width", { unsigned: true }).notNull(),
    canvasHeight: int("canvas_height", { unsigned: true }).notNull(),
    x: int("x").notNull(),
    y: int("y").notNull(),
    targetPolicy: varchar("target_policy", { length: 32 }).notNull(),
    linkTargetFrameIndex: int("link_target_frame_index", { unsigned: true }),
    sourceDecodedBgraSha256: sha256("source_decoded_bgra_sha256"),
    sourceAlphaSha256: sha256("source_alpha_sha256"),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("profession_skill_frame_targets_frame_uq").on(
      table.jobId,
      table.attempt,
      table.skillId,
      table.entryIndex,
      table.frameIndex,
    ),
    uniqueIndex("profession_skill_frame_targets_ordinal_uq").on(
      table.jobId,
      table.attempt,
      table.skillId,
      table.frameOrdinal,
    ),
    uniqueIndex("profession_skill_frame_targets_generation_uq").on(
      table.jobId,
      table.attempt,
      table.skillId,
      table.generationOrdinal,
    ),
    index("profession_skill_frame_targets_run_skill_idx").on(
      table.runId,
      table.skillId,
      table.targetPolicy,
    ),
    index("profession_skill_frame_targets_manifest_idx").on(
      table.manifestArtifactId,
    ),
    check(
      "profession_skill_frame_targets_policy_ck",
      sql`${table.targetPolicy} in ('generate-same-size', 'preserve-hidden-source', 'reuse-link-target')`,
    ),
    check(
      "profession_skill_frame_targets_img_version_ck",
      sql`${table.imgVersion} between 1 and 6`,
    ),
    check(
      "profession_skill_frame_targets_geometry_ck",
      sql`${table.width} > 0 and ${table.height} > 0 and ${table.canvasWidth} > 0 and ${table.canvasHeight} > 0`,
    ),
    check(
      "profession_skill_frame_targets_policy_evidence_ck",
      sql`(${table.targetPolicy} = 'generate-same-size' and ${table.hidden} = false and ${table.generationOrdinal} is not null and ${table.linkTargetFrameIndex} is null and ${table.sourceDecodedBgraSha256} is not null and ${table.sourceAlphaSha256} is not null) or (${table.targetPolicy} = 'preserve-hidden-source' and ${table.hidden} = true and ${table.generationOrdinal} is null and ${table.linkTargetFrameIndex} is null and ${table.sourceDecodedBgraSha256} is not null and ${table.sourceAlphaSha256} is not null) or (${table.targetPolicy} = 'reuse-link-target' and ${table.generationOrdinal} is null and ${table.linkTargetFrameIndex} is not null and ${table.sourceDecodedBgraSha256} is null and ${table.sourceAlphaSha256} is null)`,
    ),
    check(
      "profession_skill_frame_targets_link_not_self_ck",
      sql`${table.linkTargetFrameIndex} is null or ${table.linkTargetFrameIndex} <> ${table.frameIndex}`,
    ),
    foreignKey({
      columns: [table.runId, table.jobId],
      foreignColumns: [jobs.runId, jobs.id],
      name: "profession_skill_frame_targets_job_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.jobId, table.attempt, table.workerId, table.leaseId],
      foreignColumns: [
        jobAttempts.jobId,
        jobAttempts.attempt,
        jobAttempts.workerId,
        jobAttempts.leaseId,
      ],
      name: "profession_skill_frame_targets_attempt_lease_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.skillId],
      foreignColumns: [
        styleSkillProductions.runId,
        styleSkillProductions.skillId,
      ],
      name: "profession_skill_frame_targets_run_skill_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.manifestArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "profession_skill_frame_targets_manifest_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sourceRunId, table.sourceFrameManifestArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "profession_skill_frame_targets_source_artifact_run_fk",
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
      name: "profession_skill_frame_targets_manifest_upload_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.jobId,
        table.attempt,
        table.skillId,
        table.entryIndex,
        table.linkTargetFrameIndex,
      ],
      foreignColumns: [
        table.jobId,
        table.attempt,
        table.skillId,
        table.entryIndex,
        table.frameIndex,
      ],
      name: "profession_skill_frame_targets_link_target_fk",
    }).onDelete("restrict"),
  ],
);
