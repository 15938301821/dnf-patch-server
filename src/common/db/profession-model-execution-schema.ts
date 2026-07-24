/**
 * @fileoverview 定义单技能 Profession 固定模型步骤的幂等执行聚合；不保存模型正文、对象字节，
 * 不执行模型调用或本机工具，也不把参考图视为可直接运行的技能帧。
 * @module common/db/profession-model-execution-schema
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Job 模块的模型执行 Repository 读写本表，Job attempt 关闭流程终结遗留执行，
 * drizzle-kit 从本定义生成/校验 migration。输入是 Server 固定阶段、当前 JobAttempt 和脱敏证据 ID；
 * 输出为内部数据库行，不是 Worker ViewModel。副作用只由调用方 transaction 产生。
 * 安全边界：唯一键阻止同 attempt/stage 重复出站，复合外键绑定 Job/Run/Worker/lease/skill，
 * CHECK 强制每种状态的模型、图片与 Artifact 证据组合；这些证据不证明客户端兼容或部署。
 */
import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  foreignKey,
  index,
  int,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
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

/**
 * 单技能固定模型步骤的幂等执行聚合；Server 模型桥接生产，Worker 只消费最终 Artifact 标识。
 * `(jobId, attempt, skillId, stage)` 唯一，且 Worker/lease 必须属于同一 JobAttempt；`egressing`
 * 表示该轮次的唯一出站权已消费，崩溃恢复只能转为 indeterminate，不能自动再次调用模型。
 */
export const professionSkillModelExecutions = mysqlTable(
  "profession_skill_model_executions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    runId: varchar("run_id", { length: 64 })
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    jobId: varchar("job_id", { length: 64 }).notNull(),
    workerId: varchar("worker_id", { length: 64 })
      .notNull()
      .references(() => workers.id, { onDelete: "restrict" }),
    leaseId: varchar("lease_id", { length: 64 }).notNull(),
    attempt: int("attempt", { unsigned: true }).notNull(),
    skillId: varchar("skill_id", { length: 64 }).notNull(),
    /** 只允许 Server 固定的 Engineer -> Artist 两阶段，不接受 Worker 自定义步骤名。 */
    stage: varchar("stage", { length: 32 }).notNull(),
    /** 绑定冻结 Prompt 组合；同一记录后续状态变更不得替换。 */
    promptSha256: varchar("prompt_sha256", { length: 64 }).notNull(),
    modelCallId: varchar("model_call_id", { length: 64 }),
    imageAttemptId: varchar("image_attempt_id", { length: 64 }),
    outputArtifactId: varchar("output_artifact_id", { length: 64 }),
    outputSha256: varchar("output_sha256", { length: 64 }),
    outputByteLength: int("output_byte_length", { unsigned: true }),
    status: varchar("status", { length: 32 }).notNull(),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
    finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
  },
  (table) => [
    uniqueIndex("profession_skill_model_executions_step_uq").on(
      table.jobId,
      table.attempt,
      table.skillId,
      table.stage,
    ),
    index("profession_skill_model_executions_attempt_lease_idx").on(
      table.jobId,
      table.attempt,
      table.workerId,
      table.leaseId,
    ),
    index("profession_skill_model_executions_run_skill_idx").on(
      table.runId,
      table.skillId,
    ),
    check(
      "profession_skill_model_executions_stage_ck",
      sql`${table.stage} in ('engineer-plan-v1', 'reference-image-v1')`,
    ),
    check(
      "profession_skill_model_executions_status_ck",
      sql`${table.status} in ('prepared', 'egressing', 'persisting', 'passed', 'failed', 'indeterminate')`,
    ),
    check(
      "profession_skill_model_executions_finished_ck",
      sql`(${table.status} in ('prepared', 'egressing', 'persisting') and ${table.finishedAt} is null) or (${table.status} in ('passed', 'failed', 'indeterminate') and ${table.finishedAt} is not null)`,
    ),
    check(
      "profession_skill_model_executions_evidence_ck",
      sql`(${table.status} = 'prepared' and ${table.modelCallId} is null and ${table.imageAttemptId} is null and ${table.outputArtifactId} is null and ${table.outputSha256} is null and ${table.outputByteLength} is null and ${table.errorCode} is null) or (${table.status} = 'egressing' and ${table.imageAttemptId} is null and ${table.outputArtifactId} is null and ${table.outputSha256} is null and ${table.outputByteLength} is null and ${table.errorCode} is null) or (${table.status} = 'persisting' and ${table.modelCallId} is not null and ${table.imageAttemptId} is null and ${table.outputArtifactId} is null and ${table.outputSha256} is not null and ${table.outputByteLength} is not null and ${table.errorCode} is null) or (${table.status} = 'passed' and ${table.modelCallId} is not null and ((${table.stage} = 'engineer-plan-v1' and ${table.imageAttemptId} is null) or (${table.stage} = 'reference-image-v1' and ${table.imageAttemptId} is not null)) and ${table.outputArtifactId} is not null and ${table.outputSha256} is not null and ${table.outputByteLength} is not null and ${table.errorCode} is null) or (${table.status} = 'failed' and ${table.imageAttemptId} is null and ${table.outputArtifactId} is null and ${table.outputSha256} is null and ${table.outputByteLength} is null and ${table.errorCode} is not null) or (${table.status} = 'indeterminate' and ${table.imageAttemptId} is null and ${table.outputArtifactId} is null and ${table.errorCode} is not null and ((${table.outputSha256} is null and ${table.outputByteLength} is null) or (${table.modelCallId} is not null and ${table.outputSha256} is not null and ${table.outputByteLength} is not null)))`,
    ),
    foreignKey({
      columns: [table.runId, table.jobId],
      foreignColumns: [jobs.runId, jobs.id],
      name: "profession_skill_model_executions_job_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.jobId, table.attempt, table.workerId, table.leaseId],
      foreignColumns: [
        jobAttempts.jobId,
        jobAttempts.attempt,
        jobAttempts.workerId,
        jobAttempts.leaseId,
      ],
      name: "profession_skill_model_executions_attempt_lease_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.skillId],
      foreignColumns: [
        styleSkillProductions.runId,
        styleSkillProductions.skillId,
      ],
      name: "profession_skill_model_executions_run_skill_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.modelCallId],
      foreignColumns: [modelCalls.runId, modelCalls.id],
      name: "profession_skill_model_executions_model_call_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.imageAttemptId],
      foreignColumns: [imageAttempts.runId, imageAttempts.id],
      name: "profession_skill_model_executions_image_attempt_run_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.outputArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "profession_skill_model_executions_artifact_run_fk",
    }).onDelete("restrict"),
  ],
);
