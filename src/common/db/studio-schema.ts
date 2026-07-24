/**
 * @fileoverview 定义职业、技能、风格及逐技能生产证据表；不保存官方资源正文、不执行本机工具，
 * 也不把候选产物状态当作部署或客户端兼容证明。
 * @module common/db/studio-schema
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Profession 纵向模块的 Repository 在 transaction 中读写，Drizzle migration 消费
 * 定义；跨表外键引用 control schema 的 Project/Run/Job/Artifact/ModelCall/ImageAttempt。输入是已
 * 校验 DTO 与冻结证据 ID，输出是内部数据库行。安全边界：所有生产状态必须由同 Run/职业/风格/
 * 技能证据支持；官方 NPK 只读，JSON 读写都需运行时解析，限制性外键和 passed CHECK 不得放宽。
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
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  artifacts,
  imageAttempts,
  jobAttempts,
  jobs,
  modelCalls,
  npkInventories,
  npkInventoryEntries,
  projectSnapshots,
  projects,
  runs,
  users,
  workers,
} from "./schema.js";
import { artifactUploadSessions } from "./artifact-schema.js";

const id = (name: string) => varchar(name, { length: 64 });
const sha256 = (name: string) => varchar(name, { length: 64 });
const utc = (name: string) => datetime(name, { mode: "date", fsp: 3 });

/**
 * 用户拥有的职业目录根；生产方是 Profession Repository，消费方是技能/风格与 PatchTask 流程。
 * ownerUserId 是稳定租户边界，name/slug 仅展示或路由；workflowProjectId 与 catalogSnapshotId 必须
 * 同时为空或同时存在，并由复合外键证明 Snapshot 属于该 Project。
 */
export const professions = mysqlTable(
  "professions",
  {
    id: id("id").primaryKey(),
    /** 持久化用户所有者；null 仅保留历史/系统记录语义，不能由 displayName 补猜。 */
    ownerUserId: id("owner_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    canonicalName: varchar("canonical_name", { length: 200 }).notNull(),
    /** 生产工作流绑定的 Project；创建 PatchTask 前必须与 catalogSnapshotId 成对存在。 */
    workflowProjectId: id("workflow_project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    /** 已审核职业目录所依据的 Snapshot，必须属于 workflowProjectId。 */
    catalogSnapshotId: id("catalog_snapshot_id"),
    publishStatus: varchar("publish_status", { length: 32 })
      .notNull()
      .default("private"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    index("professions_owner_user_idx").on(table.ownerUserId),
    uniqueIndex("professions_owner_slug_uq").on(table.ownerUserId, table.slug),
    uniqueIndex("professions_owner_canonical_name_uq").on(
      table.ownerUserId,
      table.canonicalName,
    ),
    uniqueIndex("professions_workflow_project_uq").on(table.workflowProjectId),
    check(
      "professions_publish_status_ck",
      sql`${table.publishStatus} in ('private', 'pending', 'published', 'rejected')`,
    ),
    check(
      "professions_workflow_binding_ck",
      sql`(${table.workflowProjectId} is null and ${table.catalogSnapshotId} is null) or (${table.workflowProjectId} is not null and ${table.catalogSnapshotId} is not null)`,
    ),
    foreignKey({
      columns: [table.workflowProjectId, table.catalogSnapshotId],
      foreignColumns: [projectSnapshots.projectId, projectSnapshots.id],
      name: "professions_catalog_snapshot_project_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * 职业技能事实与可执行证据状态；生产方是目录导入/审核 Service，消费方是风格选择和生产编排。
 * `build-ready` 必须同时具备 verified 映射、producing Run、inventory/entry、帧 manifest Artifact
 * 与元数据哈希；Prompt JSON 与其 SHA-256 必须同时为空或同时存在，不能按技能名猜测映射。
 */
export const professionSkills = mysqlTable(
  "profession_skills",
  {
    id: id("id").primaryKey(),
    professionId: id("profession_id")
      .notNull()
      .references(() => professions.id, { onDelete: "restrict" }),
    stableKey: varchar("stable_key", { length: 160 }).notNull(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    promptStatus: varchar("prompt_status", { length: 32 })
      .notNull()
      .default("candidate"),
    mappingStatus: varchar("mapping_status", { length: 32 })
      .notNull()
      .default("unverified"),
    executionStatus: varchar("execution_status", { length: 32 })
      .notNull()
      .default("draft-only"),
    /** 产生 inventory 与帧 manifest 的 Run，必须与后续两个来源引用保持一致。 */
    sourceRunId: id("source_run_id").references(() => runs.id, {
      onDelete: "restrict",
    }),
    sourceInventoryId: id("source_inventory_id"),
    /** 必须属于 sourceInventoryId 的具体 IMG entry，不能按 internalPath 猜测。 */
    sourceInventoryEntryId: id("source_inventory_entry_id"),
    /** 必须属于 sourceRunId 的已复核帧 manifest Artifact。 */
    sourceFrameManifestArtifactId: id("source_frame_manifest_artifact_id"),
    sourceMetadataSha256: sha256("source_metadata_sha256"),
    /** 经领域 schema 验证的冻结 Prompt JSON；数据库读取后仍按 unknown 重新解析。 */
    professionPrompt: json("profession_prompt").$type<unknown>(),
    professionPromptSha256: sha256("profession_prompt_sha256"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    index("profession_skills_profession_idx").on(table.professionId),
    uniqueIndex("profession_skills_stable_key_uq").on(
      table.professionId,
      table.stableKey,
    ),
    uniqueIndex("profession_skills_profession_id_uq").on(
      table.professionId,
      table.id,
    ),
    uniqueIndex("profession_skills_source_inventory_uq").on(
      table.professionId,
      table.id,
      table.sourceInventoryId,
    ),
    check(
      "profession_skills_prompt_status_ck",
      sql`${table.promptStatus} in ('candidate', 'reviewed')`,
    ),
    check(
      "profession_skills_mapping_status_ck",
      sql`${table.mappingStatus} in ('unverified', 'verified')`,
    ),
    check(
      "profession_skills_execution_status_ck",
      sql`${table.executionStatus} in ('draft-only', 'build-ready')`,
    ),
    check(
      "profession_skills_build_ready_evidence_ck",
      sql`${table.executionStatus} <> 'build-ready' or (${table.mappingStatus} = 'verified' and ${table.sourceRunId} is not null and ${table.sourceInventoryId} is not null and ${table.sourceInventoryEntryId} is not null and ${table.sourceFrameManifestArtifactId} is not null and ${table.sourceMetadataSha256} is not null)`,
    ),
    check(
      "profession_skills_prompt_binding_ck",
      sql`(${table.professionPrompt} is null and ${table.professionPromptSha256} is null) or (${table.professionPrompt} is not null and ${table.professionPromptSha256} is not null)`,
    ),
    foreignKey({
      columns: [table.sourceRunId, table.sourceInventoryId],
      foreignColumns: [npkInventories.runId, npkInventories.id],
      name: "profession_skills_source_inventory_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sourceInventoryId, table.sourceInventoryEntryId],
      foreignColumns: [npkInventoryEntries.inventoryId, npkInventoryEntries.id],
      name: "profession_skills_source_inventory_entry_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sourceRunId, table.sourceFrameManifestArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "profession_skills_source_artifact_run_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * 某职业下的视觉风格定义；生产方是受认证编辑/审核 Service，消费方是逐技能 Prompt 与生产 Run。
 * canonicalName 在同职业内唯一，publishStatus 只表示目录审核状态；themeDefinition 从数据库读取后
 * 仍是不可信 JSON，必须经版本化 schema 解析，不能直接成为任意模型/工具输入。
 */
export const professionStyles = mysqlTable(
  "profession_styles",
  {
    id: id("id").primaryKey(),
    professionId: id("profession_id")
      .notNull()
      .references(() => professions.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 160 }).notNull(),
    canonicalName: varchar("canonical_name", { length: 200 }).notNull(),
    description: text("description").notNull(),
    agent: text("agent").notNull(),
    prompt: text("prompt").notNull(),
    /** 版本化主题结构；生产方写前、消费方读后都需 Zod 校验。 */
    themeDefinition: json("theme_definition").$type<unknown>(),
    publishStatus: varchar("publish_status", { length: 32 })
      .notNull()
      .default("private"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    index("profession_styles_profession_idx").on(table.professionId),
    uniqueIndex("profession_styles_name_uq").on(
      table.professionId,
      table.canonicalName,
    ),
    uniqueIndex("profession_styles_profession_id_uq").on(
      table.professionId,
      table.id,
    ),
    check(
      "profession_styles_publish_status_ck",
      sql`${table.publishStatus} in ('private', 'pending', 'published', 'rejected')`,
    ),
  ],
);

/**
 * 风格选中的技能及其有序覆盖配置；生产方是风格保存 Service，消费方是生产任务编排。
 * 复合外键保证 styleId 与 skillId 同属 professionId；同一风格 ordinal 唯一，文本仅是声明式
 * Prompt/验收输入，不能承载 executable、shell、脚本路径或部署指令。
 */
export const professionStyleSkills = mysqlTable(
  "profession_style_skills",
  {
    professionId: id("profession_id")
      .notNull()
      .references(() => professions.id, { onDelete: "restrict" }),
    styleId: id("style_id").notNull(),
    skillId: id("skill_id").notNull(),
    /** 风格内稳定排序位置；由保存 DTO 生产并受唯一索引约束。 */
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    customPrompt: text("custom_prompt"),
    changes: text("changes"),
    acceptanceCriteria: text("acceptance_criteria"),
    exclusions: text("exclusions"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.styleId, table.skillId],
      name: "profession_style_skills_pk",
    }),
    uniqueIndex("profession_style_skills_ordinal_uq").on(
      table.styleId,
      table.ordinal,
    ),
    foreignKey({
      columns: [table.professionId, table.styleId],
      foreignColumns: [professionStyles.professionId, professionStyles.id],
      name: "profession_style_skills_style_profession_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.professionId, table.skillId],
      foreignColumns: [professionSkills.professionId, professionSkills.id],
      name: "profession_style_skills_skill_profession_fk",
    }).onDelete("restrict"),
  ],
);

/**
 * 单个风格技能在一个 Run 中的生产状态与证据链；生产方是 Profession 工作流 Service，消费方是
 * 状态查询与最终打包。`passed` 必须同时绑定同 Run ModelCall、ImageAttempt、固定 Aseprite profile/
 * 二进制哈希、适配 Artifact 和验证 Artifact；这些证据仍不证明客户端兼容或部署。
 */
export const styleSkillProductions = mysqlTable(
  "style_skill_productions",
  {
    id: id("id").primaryKey(),
    professionId: id("profession_id").notNull(),
    styleId: id("style_id").notNull(),
    skillId: id("skill_id").notNull(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    jobId: id("job_id"),
    /** 终态接收方必须绑定当前 JobAttempt；派发前 planned/blocked 记录保持为空。 */
    workerId: id("worker_id").references(() => workers.id, {
      onDelete: "restrict",
    }),
    leaseId: id("lease_id"),
    attempt: int("attempt", { unsigned: true }),
    /** 提供只读源帧 manifest 的 producing Run，与当前生产 Run 分离且必须有来源证据。 */
    sourceRunId: id("source_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    sourceFrameManifestArtifactId: id(
      "source_frame_manifest_artifact_id",
    ).notNull(),
    promptSha256: sha256("prompt_sha256").notNull(),
    modelCallId: id("model_call_id"),
    imageAttemptId: id("image_attempt_id"),
    /** Worker 已登记的固定工具 profile；不能来自任意可执行路径。 */
    asepriteProfileId: varchar("aseprite_profile_id", { length: 128 }),
    asepriteBinarySha256: sha256("aseprite_binary_sha256"),
    asepriteAdapterSha256: sha256("aseprite_adapter_sha256"),
    asepriteArtifactId: id("aseprite_artifact_id"),
    asepriteUploadId: id("aseprite_upload_id"),
    validationArtifactId: id("validation_artifact_id"),
    validationUploadId: id("validation_upload_id"),
    status: varchar("status", { length: 32 }).notNull().default("planned"),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    finishedAt: utc("finished_at"),
  },
  (table) => [
    index("style_skill_productions_style_idx").on(table.styleId),
    index("style_skill_productions_run_idx").on(table.runId),
    uniqueIndex("style_skill_productions_run_skill_uq").on(
      table.runId,
      table.skillId,
    ),
    check(
      "style_skill_productions_status_ck",
      sql`${table.status} in ('planned', 'generating', 'adapting', 'validating', 'passed', 'failed', 'blocked')`,
    ),
    check(
      "style_skill_productions_finished_ck",
      sql`(${table.status} in ('passed', 'failed', 'blocked') and ${table.finishedAt} is not null) or (${table.status} not in ('passed', 'failed', 'blocked') and ${table.finishedAt} is null)`,
    ),
    check(
      "style_skill_productions_passed_evidence_ck",
      sql`${table.status} <> 'passed' or (${table.jobId} is not null and ${table.workerId} is not null and ${table.leaseId} is not null and ${table.attempt} is not null and ${table.modelCallId} is not null and ${table.imageAttemptId} is not null and ${table.asepriteProfileId} is not null and ${table.asepriteBinarySha256} is not null and ${table.asepriteAdapterSha256} is not null and ${table.asepriteArtifactId} is not null and ${table.asepriteUploadId} is not null and ${table.validationArtifactId} is not null and ${table.validationUploadId} is not null and ${table.errorCode} is null)`,
    ),
    check(
      "style_skill_productions_error_evidence_ck",
      sql`${table.status} not in ('failed', 'blocked') or ((${table.jobId} is null and ${table.workerId} is null and ${table.leaseId} is null and ${table.attempt} is null and ${table.errorCode} is null) or (${table.jobId} is not null and ${table.workerId} is not null and ${table.leaseId} is not null and ${table.attempt} is not null and ${table.errorCode} is not null))`,
    ),
    foreignKey({
      columns: [table.professionId, table.styleId],
      foreignColumns: [professionStyles.professionId, professionStyles.id],
      name: "style_skill_productions_style_profession_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.professionId, table.skillId],
      foreignColumns: [professionSkills.professionId, professionSkills.id],
      name: "style_skill_productions_skill_profession_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.styleId, table.skillId],
      foreignColumns: [
        professionStyleSkills.styleId,
        professionStyleSkills.skillId,
      ],
      name: "style_skill_productions_selected_skill_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.jobId],
      foreignColumns: [jobs.runId, jobs.id],
      name: "style_skill_productions_job_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.jobId, table.attempt, table.workerId, table.leaseId],
      foreignColumns: [
        jobAttempts.jobId,
        jobAttempts.attempt,
        jobAttempts.workerId,
        jobAttempts.leaseId,
      ],
      name: "style_skill_productions_attempt_lease_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.modelCallId],
      foreignColumns: [modelCalls.runId, modelCalls.id],
      name: "style_skill_productions_model_call_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.imageAttemptId],
      foreignColumns: [imageAttempts.runId, imageAttempts.id],
      name: "style_skill_productions_image_attempt_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.sourceRunId, table.sourceFrameManifestArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_skill_productions_source_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.asepriteArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_skill_productions_aseprite_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.validationArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_skill_productions_validation_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.asepriteUploadId,
        table.runId,
        table.jobId,
        table.workerId,
        table.leaseId,
        table.attempt,
        table.asepriteArtifactId,
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
      name: "style_skill_productions_aseprite_upload_fk",
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
      name: "style_skill_productions_validation_upload_fk",
    }).onDelete("restrict"),
  ],
);
