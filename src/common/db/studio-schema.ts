/**
 * @fileoverview DNF Patch Studio 的职业、技能、主题及逐技能生产元数据表；不保存官方资源正文，也不执行本机工具。
 * @module common/db/studio-schema
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  foreignKey,
  index,
  int,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  artifacts,
  imageAttempts,
  jobs,
  modelCalls,
  npkInventories,
  npkInventoryEntries,
  projectSnapshots,
  projects,
  runs,
} from "./schema.js";

const id = (name: string) => varchar(name, { length: 64 });
const sha256 = (name: string) => varchar(name, { length: 64 });
const utc = (name: string) => datetime(name, { mode: "date", fsp: 3 });

export const professions = mysqlTable(
  "professions",
  {
    id: id("id").primaryKey(),
    name: varchar("name", { length: 160 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull(),
    canonicalName: varchar("canonical_name", { length: 200 }).notNull(),
    workflowProjectId: id("workflow_project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    catalogSnapshotId: id("catalog_snapshot_id"),
    publishStatus: varchar("publish_status", { length: 32 })
      .notNull()
      .default("private"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("professions_slug_uq").on(table.slug),
    uniqueIndex("professions_canonical_name_uq").on(table.canonicalName),
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
    sourceRunId: id("source_run_id").references(() => runs.id, {
      onDelete: "restrict",
    }),
    sourceInventoryId: id("source_inventory_id"),
    sourceInventoryEntryId: id("source_inventory_entry_id"),
    sourceFrameManifestArtifactId: id("source_frame_manifest_artifact_id"),
    sourceMetadataSha256: sha256("source_metadata_sha256"),
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

export const professionStyleSkills = mysqlTable(
  "profession_style_skills",
  {
    professionId: id("profession_id")
      .notNull()
      .references(() => professions.id, { onDelete: "restrict" }),
    styleId: id("style_id").notNull(),
    skillId: id("skill_id").notNull(),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    customPrompt: text("custom_prompt"),
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
    sourceRunId: id("source_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    sourceFrameManifestArtifactId: id(
      "source_frame_manifest_artifact_id",
    ).notNull(),
    promptSha256: sha256("prompt_sha256").notNull(),
    modelCallId: id("model_call_id"),
    imageAttemptId: id("image_attempt_id"),
    asepriteProfileId: varchar("aseprite_profile_id", { length: 128 }),
    asepriteBinarySha256: sha256("aseprite_binary_sha256"),
    asepriteArtifactId: id("aseprite_artifact_id"),
    validationArtifactId: id("validation_artifact_id"),
    status: varchar("status", { length: 32 }).notNull().default("planned"),
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
      sql`${table.status} <> 'passed' or (${table.modelCallId} is not null and ${table.imageAttemptId} is not null and ${table.asepriteProfileId} is not null and ${table.asepriteBinarySha256} is not null and ${table.asepriteArtifactId} is not null and ${table.validationArtifactId} is not null)`,
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
  ],
);

export const stylePackages = mysqlTable(
  "style_packages",
  {
    id: id("id").primaryKey(),
    professionId: id("profession_id").notNull(),
    styleId: id("style_id").notNull(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    packageArtifactId: id("package_artifact_id"),
    manifestSha256: sha256("manifest_sha256"),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    finishedAt: utc("finished_at"),
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
