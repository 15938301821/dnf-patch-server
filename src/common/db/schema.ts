import {
  boolean,
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

const id = (name: string) => varchar(name, { length: 64 });
const sha256 = (name: string) => varchar(name, { length: 64 });
const utc = (name: string) => datetime(name, { mode: "date", fsp: 3 });

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

export const runs = mysqlTable(
  "runs",
  {
    id: id("id").primaryKey(),
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
    index("runs_project_idx").on(table.projectId),
    foreignKey({
      columns: [table.projectId, table.snapshotId],
      foreignColumns: [projectSnapshots.projectId, projectSnapshots.id],
      name: "runs_snapshot_project_fk",
    }).onDelete("restrict"),
    uniqueIndex("runs_idempotency_uq").on(
      table.projectId,
      table.idempotencyKey,
    ),
    uniqueIndex("runs_client_uq").on(table.projectId, table.clientRunId),
  ],
);

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
    evidenceArtifactId: id("evidence_artifact_id").references(
      () => artifacts.id,
      { onDelete: "restrict" },
    ),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_events_sequence_uq").on(table.runId, table.sequence),
  ],
);

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
    leaseExpiresAt: utc("lease_expires_at"),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(3),
    createdAt: utc("created_at").notNull(),
    updatedAt: utc("updated_at").notNull(),
  },
  (table) => [
    index("jobs_claim_idx").on(table.status, table.kind, table.leaseExpiresAt),
    index("jobs_run_idx").on(table.runId),
  ],
);

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
    attempt: int("attempt", { unsigned: true }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    resultSha256: sha256("result_sha256"),
    errorCode: varchar("error_code", { length: 80 }),
    errorMessage: text("error_message"),
    startedAt: utc("started_at").notNull(),
    finishedAt: utc("finished_at"),
  },
  (table) => [uniqueIndex("job_attempts_uq").on(table.jobId, table.attempt)],
);

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
  (table) => [index("artifacts_run_idx").on(table.runId)],
);

export const npkInventories = mysqlTable(
  "npk_inventories",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    sourceLabel: varchar("source_label", { length: 200 }).notNull(),
    sourceLength: int("source_length", { unsigned: true }).notNull(),
    sourceSha256: sha256("source_sha256").notNull(),
    entryCount: int("entry_count", { unsigned: true }).notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    inventoryArtifactId: id("inventory_artifact_id").references(
      () => artifacts.id,
      { onDelete: "restrict" },
    ),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [index("npk_inventories_project_idx").on(table.projectId)],
);

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
    uniqueIndex("npk_entries_path_uq").on(
      table.inventoryId,
      table.internalPath,
    ),
  ],
);

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
    requestSha256: sha256("request_sha256").notNull(),
    responseSha256: sha256("response_sha256"),
    responseId: varchar("response_id", { length: 160 }),
    status: varchar("status", { length: 32 }).notNull(),
    modelEgressAuthorized: boolean("model_egress_authorized").notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: utc("created_at").notNull(),
    finishedAt: utc("finished_at"),
  },
  (table) => [index("model_calls_run_idx").on(table.runId)],
);

export const imageAttempts = mysqlTable(
  "image_attempts",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    modelCallId: id("model_call_id").references(() => modelCalls.id, {
      onDelete: "restrict",
    }),
    promptSha256: sha256("prompt_sha256").notNull(),
    inputSnapshotSha256: sha256("input_snapshot_sha256").notNull(),
    generationConfigSha256: sha256("generation_config_sha256").notNull(),
    actualSeed: varchar("actual_seed", { length: 80 }),
    adapterIdentity: varchar("adapter_identity", { length: 200 }).notNull(),
    outputArtifactId: id("output_artifact_id").references(() => artifacts.id, {
      onDelete: "restrict",
    }),
    status: varchar("status", { length: 32 }).notNull(),
    directRuntimeUseAllowed: boolean("direct_runtime_use_allowed")
      .notNull()
      .default(false),
    createdAt: utc("created_at").notNull(),
  },
  (table) => [index("image_attempts_run_idx").on(table.runId)],
);

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

export const manualReviews = mysqlTable(
  "manual_reviews",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 32 }).notNull(),
    reviewer: varchar("reviewer", { length: 160 }),
    evidenceArtifactId: id("evidence_artifact_id").references(
      () => artifacts.id,
      { onDelete: "restrict" },
    ),
    createdAt: utc("created_at").notNull(),
    completedAt: utc("completed_at"),
  },
  (table) => [index("manual_reviews_run_idx").on(table.runId)],
);

export const outboxEvents = mysqlTable(
  "outbox_events",
  {
    id: id("id").primaryKey(),
    topic: varchar("topic", { length: 120 }).notNull(),
    aggregateId: id("aggregate_id").notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: utc("created_at").notNull(),
    publishedAt: utc("published_at"),
  },
  (table) => [
    index("outbox_pending_idx").on(table.publishedAt, table.createdAt),
  ],
);
