/**
 * @fileoverview 定义 Profession V6 从官方 target manifest 冻结的逐帧事实及其有界模型生成状态；
 * 不保存图片正文、Provider 参数或本机路径，也不执行查询或 migration。
 * @module common/db/profession-frame-target-schema
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：Job 模块的 target prepare Repository 在事务中写入本表，逐帧模型 Repository 再以状态机
 * 更新同一 attempt 的生成证据；DatabaseService 合并 schema，drizzle-kit 据此生成 migration。输入来自
 * Server 已完整复读的 manifest、ModelCall 与正规化 PNG，输出是内部数据库行，不是 Worker DTO。
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
  type MySqlDateTimeBuilderInitial,
  type MySqlVarCharBuilderInitial,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { artifactUploadSessions } from "./artifact-schema.js";
import {
  artifacts,
  imageAttempts,
  jobAttempts,
  jobs,
  modelCalls,
  runs,
  workers,
} from "./schema.js";
import { styleSkillProductions } from "./studio-schema.js";

type Varchar64Builder<TName extends string> = MySqlVarCharBuilderInitial<
  TName,
  [string, ...string[]],
  64
>;

const id = <TName extends string>(name: TName): Varchar64Builder<TName> =>
  varchar(name, { length: 64 });
const sha256 = <TName extends string>(name: TName): Varchar64Builder<TName> =>
  varchar(name, { length: 64 });
const utc = <TName extends string>(
  name: TName,
): MySqlDateTimeBuilderInitial<TName> =>
  datetime(name, { mode: "date", fsp: 3 });

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
    /** Worker 从同一 BGRA 导出的官方 PNG；只有 finalize 且登记成功后整组写入。 */
    sourcePngArtifactId: id("source_png_artifact_id"),
    sourcePngUploadId: id("source_png_upload_id"),
    sourcePngSha256: sha256("source_png_sha256"),
    sourcePngByteLength: int("source_png_byte_length", { unsigned: true }),
    sourcePngRegisteredAt: utc("source_png_registered_at"),
    /** null 表示尚未生成；其余状态由逐帧模型 Repository 按 CHECK 允许的顺序推进。 */
    generationStatus: varchar("generation_status", { length: 32 }),
    generationModelCallId: id("generation_model_call_id"),
    generationImageAttemptId: id("generation_image_attempt_id"),
    targetPngArtifactId: id("target_png_artifact_id"),
    targetPngSha256: sha256("target_png_sha256"),
    targetPngByteLength: int("target_png_byte_length", { unsigned: true }),
    targetNormalizationAlgorithm: varchar("target_normalization_algorithm", {
      length: 100,
    }),
    generationErrorCode: varchar("generation_error_code", { length: 100 }),
    generationStartedAt: utc("generation_started_at"),
    generationFinishedAt: utc("generation_finished_at"),
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
    check(
      "profession_skill_frame_targets_source_png_ck",
      sql`(${table.sourcePngArtifactId} is null and ${table.sourcePngUploadId} is null and ${table.sourcePngSha256} is null and ${table.sourcePngByteLength} is null and ${table.sourcePngRegisteredAt} is null) or (${table.targetPolicy} = 'generate-same-size' and ${table.sourcePngArtifactId} is not null and ${table.sourcePngUploadId} is not null and ${table.sourcePngSha256} is not null and ${table.sourcePngByteLength} > 0 and ${table.sourcePngRegisteredAt} is not null)`,
    ),
    check(
      "profession_skill_frame_targets_generation_status_ck",
      sql`${table.generationStatus} is null or (${table.targetPolicy} = 'generate-same-size' and ${table.generationStatus} in ('reserved', 'egressing', 'persisting', 'passed', 'blocked'))`,
    ),
    check(
      "profession_skill_frame_targets_generation_evidence_ck",
      sql`(${table.generationStatus} is null and ${table.generationModelCallId} is null and ${table.generationImageAttemptId} is null and ${table.targetPngArtifactId} is null and ${table.targetPngSha256} is null and ${table.targetPngByteLength} is null and ${table.targetNormalizationAlgorithm} is null and ${table.generationErrorCode} is null and ${table.generationStartedAt} is null and ${table.generationFinishedAt} is null) or (${table.generationStatus} = 'reserved' and ${table.generationModelCallId} is null and ${table.generationImageAttemptId} is null and ${table.targetPngArtifactId} is null and ${table.targetPngSha256} is null and ${table.targetPngByteLength} is null and ${table.targetNormalizationAlgorithm} is null and ${table.generationErrorCode} is null and ${table.generationStartedAt} is not null and ${table.generationFinishedAt} is null) or (${table.generationStatus} = 'egressing' and ${table.generationModelCallId} is not null and ${table.generationImageAttemptId} is null and ${table.targetPngArtifactId} is null and ${table.targetPngSha256} is null and ${table.targetPngByteLength} is null and ${table.targetNormalizationAlgorithm} is null and ${table.generationErrorCode} is null and ${table.generationStartedAt} is not null and ${table.generationFinishedAt} is null) or (${table.generationStatus} = 'persisting' and ${table.generationModelCallId} is not null and ${table.generationImageAttemptId} is null and ${table.targetPngArtifactId} is null and ${table.targetPngSha256} is not null and ${table.targetPngByteLength} > 0 and ${table.targetNormalizationAlgorithm} is not null and ${table.generationErrorCode} is null and ${table.generationStartedAt} is not null and ${table.generationFinishedAt} is null) or (${table.generationStatus} = 'passed' and ${table.generationModelCallId} is not null and ${table.generationImageAttemptId} is not null and ${table.targetPngArtifactId} is not null and ${table.targetPngSha256} is not null and ${table.targetPngByteLength} > 0 and ${table.targetNormalizationAlgorithm} is not null and ${table.generationErrorCode} is null and ${table.generationStartedAt} is not null and ${table.generationFinishedAt} is not null) or (${table.generationStatus} = 'blocked' and ${table.generationImageAttemptId} is null and ${table.targetPngArtifactId} is null and ${table.targetPngSha256} is null and ${table.targetPngByteLength} is null and ${table.targetNormalizationAlgorithm} is null and ${table.generationErrorCode} is not null and ${table.generationStartedAt} is not null and ${table.generationFinishedAt} is not null)`,
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
    foreignKey({
      columns: [table.runId, table.sourcePngArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "profession_skill_frame_targets_source_png_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.generationModelCallId],
      foreignColumns: [modelCalls.runId, modelCalls.id],
      name: "profession_skill_frame_targets_model_call_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.generationImageAttemptId],
      foreignColumns: [imageAttempts.runId, imageAttempts.id],
      name: "profession_skill_frame_targets_image_attempt_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.targetPngArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "profession_skill_frame_targets_target_png_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.sourcePngUploadId,
        table.runId,
        table.jobId,
        table.workerId,
        table.leaseId,
        table.attempt,
        table.sourcePngArtifactId,
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
      name: "profession_skill_frame_targets_source_png_upload_fk",
    }).onDelete("restrict"),
  ],
);
