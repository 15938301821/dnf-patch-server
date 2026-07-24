/**
 * @fileoverview 定义调度控制面的 Drizzle 表、CHECK 与限制性外键；不执行查询、migration、本机工具或保存对象正文。
 * @module common/db/control-schema
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 * 调用关系：Repository 读写这些表，DatabaseService 合并关系 schema，drizzle-kit 据此生成 migration。输入是已校验 DTO/领域状态，输出为内部数据库行。
 * 副作用与安全边界：写入仅由调用方 transaction 执行；JSON 双向校验，归属、租约 fencing 与四项 false 状态由事务、复合外键和 CHECK 保护。
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  datetime,
  foreignKey,
  index,
  int,
  json,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./identity-schema.js";
/** 重导出身份表供统一 schema 消费；凭据持久化行不等于可返回客户端的脱敏 ViewModel。 */
export { userModelConfigurations, users } from "./identity-schema.js";
/** 重导出提交后通知表，保持各领域现有统一 schema 导入路径稳定。 */
export { outboxEvents } from "./outbox-schema.js";
const id = (name: string) => varchar(name, { length: 64 });
const sha256 = (name: string) => varchar(name, { length: 64 });
const utc = (name: string) => datetime(name, { mode: "date", fsp: 3 });
/** Factory 冻结版本、配置 JSON 与摘要；Factory Service 生产、Run 编排消费，config 读写都需 schema 校验且 enabled 不绕过版本化 jobContracts。 */
export const factories = mysqlTable(
  "factories",
  {
    id: id("id").primaryKey(),
    version: varchar("version", { length: 32 }).notNull(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    config: json("config").$type<Record<string, unknown>>().notNull(),
    configSha256: sha256("config_sha256").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [uniqueIndex("factories_version_uq").on(table.id, table.version)],
);
/** Project 绑定唯一 Factory 与规范化名称；Project Repository 生产、Snapshot/Run 消费，archived 项目不得由后续业务隐式恢复。 */
export const projects = mysqlTable(
  "projects",
  {
    id: id("id").primaryKey(),
    factoryId: id("factory_id")
      .notNull()
      .references(() => factories.id, { onDelete: "restrict" }),
    clientProjectId: varchar("client_project_id", { length: 128 }),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    canonicalName: varchar("canonical_name", { length: 200 }).notNull(),
    version: int("version", { unsigned: true }).notNull().default(1),
    archived: boolean("archived").notNull().default(false),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    index("projects_factory_idx").on(table.factoryId),
    uniqueIndex("projects_canonical_uq").on(table.canonicalName),
  ],
);
/** ProjectSnapshot 冻结规则、manifest、Prompt 与工具目录摘要；导入流程生产、Run 消费，fullSkillCoverageProven 由 CHECK 固定 false 且不因哈希存在而提升。 */
export const projectSnapshots = mysqlTable(
  "project_snapshots",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    clientSnapshotId: varchar("client_snapshot_id", { length: 128 }).notNull(),
    rootRulesSha256: sha256("root_rules_sha256").notNull(),
    manifestSha256: sha256("manifest_sha256"),
    promptTreeSha256: sha256("prompt_tree_sha256").notNull(),
    toolCatalogSha256: sha256("tool_catalog_sha256").notNull(),
    repositoryRevision: varchar("repository_revision", { length: 80 }),
    fullSkillCoverageProven: boolean("full_skill_coverage_proven")
      .notNull()
      .default(false),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    index("project_snapshots_project_idx").on(table.projectId),
    check(
      "project_snapshots_safety_state_ck",
      sql`${table.fullSkillCoverageProven} = false`,
    ),
    uniqueIndex("project_snapshots_project_id_uq").on(
      table.projectId,
      table.id,
    ),
    uniqueIndex("project_snapshots_client_uq").on(
      table.projectId,
      table.clientSnapshotId,
    ),
  ],
);
/** Run 是用户请求的权威执行聚合；Run Service 在 transaction 中生产、Job/Event/Artifact 消费，ownerUserId、Project/Snapshot、幂等键和指纹须一致，四项安全证明固定 false。 */
export const runs = mysqlTable(
  "runs",
  {
    id: id("id").primaryKey(),
    ownerUserId: id("owner_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    snapshotId: id("snapshot_id")
      .notNull()
      .references(() => projectSnapshots.id, { onDelete: "restrict" }),
    clientRunId: varchar("client_run_id", { length: 128 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    action: varchar("action", { length: 40 }).notNull(),
    status: varchar("status", { length: 48 }).notNull(),
    currentStage: varchar("current_stage", { length: 96 }).notNull(),
    requestSha256: sha256("request_sha256").notNull(),
    requestFingerprintSha256: sha256("request_fingerprint_sha256"),
    serverConnectionEnabled: boolean("server_connection_enabled")
      .notNull()
      .default(true),
    modelEgressAuthorized: boolean("model_egress_authorized")
      .notNull()
      .default(false),
    deploymentAuthorized: boolean("deployment_authorized")
      .notNull()
      .default(false),
    deploymentPerformed: boolean("deployment_performed")
      .notNull()
      .default(false),
    fullSkillCoverageProven: boolean("full_skill_coverage_proven")
      .notNull()
      .default(false),
    clientCompatibilityProven: boolean("client_compatibility_proven")
      .notNull()
      .default(false),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
    finishedAt: utc("finished_at"),
  },
  (table) => [
    index("runs_owner_user_idx").on(table.ownerUserId),
    index("runs_project_idx").on(table.projectId),
    check(
      "runs_status_ck",
      sql`${table.status} in ('queued', 'running', 'passed', 'failed', 'blocked')`,
    ),
    check(
      "runs_safety_state_ck",
      sql`${table.deploymentAuthorized} = false and ${table.deploymentPerformed} = false and ${table.fullSkillCoverageProven} = false and ${table.clientCompatibilityProven} = false`,
    ),
    foreignKey({
      columns: [table.projectId, table.snapshotId],
      foreignColumns: [projectSnapshots.projectId, projectSnapshots.id],
      name: "runs_snapshot_project_fk",
    }).onDelete("restrict"),
    uniqueIndex("runs_project_id_uq").on(table.projectId, table.id),
    uniqueIndex("runs_idempotency_uq").on(
      table.projectId,
      table.idempotencyKey,
    ),
    uniqueIndex("runs_client_uq").on(table.projectId, table.clientRunId),
  ],
);
/** RunEvent 是按 Run 单调 sequence 保存的权威事件；事务内业务流程生产、客户端恢复消费，evidenceArtifactId 必须属于同一 Run，Socket.IO 不是其替代事实源。 */
export const runEvents = mysqlTable(
  "run_events",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    sequence: int("sequence", { unsigned: true }).notNull(),
    level: varchar("level", { length: 16 }).notNull(),
    stage: varchar("stage", { length: 96 }).notNull(),
    message: text("message").notNull(),
    evidenceArtifactId: id("evidence_artifact_id"),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_events_sequence_uq").on(table.runId, table.sequence),
    foreignKey({
      columns: [table.runId, table.evidenceArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "run_events_evidence_artifact_run_fk",
    }).onDelete("restrict"),
  ],
);
/** Worker 注册身份、能力与心跳状态；Worker Service 生产、Job claim 消费，capabilities JSON 必须运行时解析，disabled Worker 不得领取任务。 */
export const workers = mysqlTable(
  "workers",
  {
    id: id("id").primaryKey(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    capabilities: json("capabilities").$type<string[]>().notNull(),
    disabled: boolean("disabled").notNull().default(false),
    lastHeartbeatAt: utc("last_heartbeat_at"),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [index("workers_disabled_idx").on(table.disabled)],
);
/** Job 保存版本化声明式 payload 与当前 lease；Run Service 生产、Worker/Job Repository 消费，leased 状态必须同时具 owner、leaseId、期限且 attemptCount 不超过 maxAttempts。 */
export const jobs = mysqlTable(
  "jobs",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    kind: varchar("kind", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    payloadSha256: sha256("payload_sha256").notNull(),
    leaseOwnerId: id("lease_owner_id").references(() => workers.id, {
      onDelete: "restrict",
    }),
    leaseId: id("lease_id"),
    leaseExpiresAt: utc("lease_expires_at"),
    dispatchReadyAt: utc("dispatch_ready_at").default(
      sql`CURRENT_TIMESTAMP(3)`,
    ),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(3),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    index("jobs_claim_idx").on(
      table.status,
      table.kind,
      table.dispatchReadyAt,
      table.leaseExpiresAt,
    ),
    index("jobs_run_idx").on(table.runId),
    uniqueIndex("jobs_run_id_uq").on(table.runId, table.id),
    check(
      "jobs_status_ck",
      sql`${table.status} in ('queued', 'leased', 'passed', 'failed', 'blocked')`,
    ),
    check(
      "jobs_attempt_limit_ck",
      sql`${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    check(
      "jobs_lease_fields_ck",
      sql`(${table.status} = 'leased' and ${table.leaseOwnerId} is not null and ${table.leaseId} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} <> 'leased' and ${table.leaseOwnerId} is null and ${table.leaseId} is null and ${table.leaseExpiresAt} is null)`,
    ),
  ],
);
/** JobAttempt 记录每次领取的 Worker、leaseId 与终态证据；claim/complete 流程生产、Artifact 等证据链消费，同一 jobId+attempt 唯一且旧 fencing 编号不得写入新轮次。 */
export const jobAttempts = mysqlTable(
  "job_attempts",
  {
    id: id("id").primaryKey(),
    jobId: id("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "restrict" }),
    workerId: id("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    leaseId: id("lease_id"),
    attempt: int("attempt", { unsigned: true }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    resultSha256: sha256("result_sha256"),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    startedAt: utc("started_at").notNull(),
    finishedAt: utc("finished_at"),
  },
  (table) => [
    uniqueIndex("job_attempts_uq").on(table.jobId, table.attempt),
    uniqueIndex("job_attempts_lease_evidence_uq").on(
      table.jobId,
      table.attempt,
      table.workerId,
      table.leaseId,
    ),
    check(
      "job_attempts_status_ck",
      sql`${table.status} in ('running', 'passed', 'failed', 'blocked', 'timed_out')`,
    ),
  ],
);
/** Artifact 仅保存同 Run 私有对象引用、长度、摘要与有界 provenance；finalize transaction 生产、下载/证据流程消费，不保存正文且不证明兼容或部署。 */
export const artifacts = mysqlTable(
  "artifacts",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    logicalName: varchar("logical_name", { length: 200 }).notNull(),
    storageKey: varchar("storage_key", { length: 500 }).notNull(),
    mediaType: varchar("media_type", { length: 120 }).notNull(),
    byteLength: int("byte_length", { unsigned: true }).notNull(),
    sha256: sha256("sha256").notNull(),
    provenance: json("provenance").$type<Record<string, unknown>>().notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    index("artifacts_run_idx").on(table.runId),
    uniqueIndex("artifacts_run_id_uq").on(table.runId, table.id),
  ],
);
/** NPK Inventory 保存只读官方来源的长度、摘要、条目数与 producing Run；受租约 Worker 流程生产、技能映射消费，Project/Run/Artifact 必须同属且不按名称猜测。 */
export const npkInventories = mysqlTable(
  "npk_inventories",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    runId: id("run_id").notNull(),
    sourceLabel: varchar("source_label", { length: 200 }).notNull(),
    sourceLength: int("source_length", { unsigned: true }).notNull(),
    sourceSha256: sha256("source_sha256").notNull(),
    entryCount: int("entry_count", { unsigned: true }).notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    inventoryArtifactId: id("inventory_artifact_id"),
    /** 同 Run 逐帧结构清单；历史记录可为空，但职业映射不能引用空值。 */
    sourceFrameManifestArtifactId: id("source_frame_manifest_artifact_id"),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    index("npk_inventories_project_idx").on(table.projectId),
    uniqueIndex("npk_inventories_run_id_uq").on(table.runId, table.id),
    foreignKey({
      columns: [table.projectId, table.runId],
      foreignColumns: [runs.projectId, runs.id],
      name: "npk_inventories_project_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.inventoryArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "npk_inventories_inventory_artifact_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.sourceFrameManifestArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "npk_inventories_frame_manifest_artifact_run_fk",
    }).onDelete("restrict"),
  ],
);
/** InventoryEntry 保存某 inventory 内 IMG 相对路径、版本、帧数与元数据摘要；inventory Worker 生产、技能来源绑定消费，internalPath 唯一但不承载文件正文。 */
export const npkInventoryEntries = mysqlTable(
  "npk_inventory_entries",
  {
    id: id("id").primaryKey(),
    inventoryId: id("inventory_id")
      .notNull()
      .references(() => npkInventories.id, { onDelete: "restrict" }),
    internalPath: varchar("internal_path", { length: 500 }).notNull(),
    imgVersion: int("img_version", { unsigned: true }).notNull(),
    frameCount: int("frame_count", { unsigned: true }).notNull(),
    metadataSha256: sha256("metadata_sha256").notNull(),
  },
  (table) => [
    uniqueIndex("npk_entries_inventory_id_uq").on(table.inventoryId, table.id),
    uniqueIndex("npk_entries_path_uq").on(
      table.inventoryId,
      table.internalPath,
    ),
  ],
);
/** ModelCall 保存固定角色、脱敏 endpoint 身份、配置版本和请求/响应摘要；模型 Service 生产、审计消费，performed 只能在 authorized 时为 true，原始响应与密钥禁止入库。 */
export const modelCalls = mysqlTable(
  "model_calls",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    role: varchar("role", { length: 32 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    endpointIdentity: varchar("endpoint_identity", { length: 300 }).notNull(),
    modelConfigurationVersion: int("model_configuration_version", {
      unsigned: true,
    }),
    requestSha256: sha256("request_sha256").notNull(),
    responseSha256: sha256("response_sha256"),
    responseId: varchar("response_id", { length: 160 }),
    status: varchar("status", { length: 32 }).notNull(),
    modelEgressAuthorized: boolean("model_egress_authorized").notNull(),
    modelEgressPerformed: boolean("model_egress_performed")
      .notNull()
      .default(false),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: utc("created_at").notNull(),
    finishedAt: utc("finished_at"),
  },
  (table) => [
    index("model_calls_run_idx").on(table.runId),
    uniqueIndex("model_calls_run_id_uq").on(table.runId, table.id),
    check(
      "model_calls_status_ck",
      sql`${table.status} in ('running', 'passed', 'failed', 'blocked', 'abandoned')`,
    ),
    check(
      "model_calls_egress_ck",
      sql`${table.modelEgressPerformed} = false or ${table.modelEgressAuthorized} = true`,
    ),
    check(
      "model_calls_finished_ck",
      sql`(${table.status} = 'running' and ${table.finishedAt} is null) or (${table.status} <> 'running' and ${table.finishedAt} is not null)`,
    ),
  ],
);
/** ImageAttempt 记录模型调用后的图像生成/适配证据；Image Service 生产、职业生产消费，关联 ModelCall/Artifact 必须同 Run，directRuntimeUseAllowed 永久为 false。 */
export const imageAttempts = mysqlTable(
  "image_attempts",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    modelCallId: id("model_call_id"),
    promptSha256: sha256("prompt_sha256").notNull(),
    inputSnapshotSha256: sha256("input_snapshot_sha256").notNull(),
    generationConfigSha256: sha256("generation_config_sha256").notNull(),
    actualSeed: varchar("actual_seed", { length: 80 }),
    adapterIdentity: varchar("adapter_identity", { length: 200 }).notNull(),
    outputArtifactId: id("output_artifact_id"),
    status: varchar("status", { length: 32 }).notNull(),
    directRuntimeUseAllowed: boolean("direct_runtime_use_allowed")
      .notNull()
      .default(false),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    index("image_attempts_run_idx").on(table.runId),
    uniqueIndex("image_attempts_run_id_uq").on(table.runId, table.id),
    foreignKey({
      columns: [table.runId, table.modelCallId],
      foreignColumns: [modelCalls.runId, modelCalls.id],
      name: "image_attempts_model_call_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.outputArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "image_attempts_output_artifact_run_fk",
    }).onDelete("restrict"),
  ],
);
/** GuardrailDecision 保存冻结策略对 Run 输入的追加式 fail-closed 决策；Guardrail Service 在创建 Job 前生产、审计消费，details JSON 需双向校验且不能夹带任意执行字段。 */
export const guardrailDecisions = mysqlTable(
  "guardrail_decisions",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    policyId: varchar("policy_id", { length: 100 }).notNull(),
    policySha256: sha256("policy_sha256").notNull(),
    inputSha256: sha256("input_sha256").notNull(),
    decision: varchar("decision", { length: 32 }).notNull(),
    reasonCode: varchar("reason_code", { length: 100 }).notNull(),
    details: json("details").$type<Record<string, unknown>>().notNull(),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [index("guardrail_run_idx").on(table.runId)],
);
/** ManualReview 保存 Run 的人工审核状态与可选同 Run 证据；审核 Service 生产、发布流程消费，approved 不等于 deploymentAuthorized 或 clientCompatibilityProven。 */
export const manualReviews = mysqlTable(
  "manual_reviews",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 32 }).notNull(),
    reviewer: varchar("reviewer", { length: 160 }),
    evidenceArtifactId: id("evidence_artifact_id"),
    createdAt: utc("created_at").notNull(),
    completedAt: utc("completed_at"),
  },
  (table) => [
    uniqueIndex("manual_reviews_run_uq").on(table.runId),
    foreignKey({
      columns: [table.runId, table.evidenceArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "manual_reviews_evidence_artifact_run_fk",
    }).onDelete("restrict"),
    check(
      "manual_reviews_status_ck",
      sql`${table.status} in ('pending', 'approved', 'rejected')`,
    ),
  ],
);
