/**
 * @fileoverview 恢复因 Worker 租约耗尽或已证明的 ModelCall 审计表迁移滞后而失败的单个
 * Profession Run；不重写历史 attempt、不处理技能业务失败，也不授权部署或提升覆盖/兼容证明。
 * @module scripts/operations
 * @author AI生成
 * @created 2026-07-27
 * @relatedPlan N/A - 当前真实 Profession Run 的控制面故障恢复
 *
 * 调用关系：维护者显式执行 `node scripts/recover-expired-profession-run.mjs <runId>`；脚本直接连接
 * 当前 Server 使用的 MySQL，不经过 HTTP，也不调用 Worker、模型、对象存储或本机工具。
 * 输入输出：输入仅允许一个 Run UUID 和环境中的 DATABASE_URL；输出为脱敏恢复摘要或稳定错误码。
 * 副作用：在一个 transaction（全部成功才提交的数据库事务）中锁定 Run/Jobs，增加一次 Profession
 * attempt 预算、恢复 deferred Package、重置未完成技能，并写权威 Run event 与 outbox 通知。
 * 安全边界：只接受最后 attempt 已由 reaper 封存为 LEASE_EXPIRED，或满足严格无 ModelCall、
 * 无模型出站证据且目标迁移已就绪的 HTTP_500；Package 从未领取且无 V3 证据、技能没有
 * failed/blocked、四项安全位全 false。任一条件不符均整体回滚。
 */
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const modelCallTelemetryColumns = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "provider_latency_ms",
];
const maxSchemaFailureAttemptMs = 5_000,
  maxSchemaFailureExecutionMs = 2_000;

try {
  await main();
} catch (error) {
  process.stderr.write(`${stableRecoveryErrorCode(error)}\n`);
  process.exitCode = 1;
}

/** 解析受限 CLI、连接当前数据库并确保所有成功/失败路径关闭会话。 */
async function main() {
  const runId = parseRunId(process.argv.slice(2));
  const databaseUrl = requiredDatabaseUrl(process.env.DATABASE_URL);
  const database = await mysql.createConnection({
    uri: databaseUrl,
    dateStrings: true,
  });
  try {
    const result = await recoverRun(database, runId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await database.end();
  }
}

/**
 * 执行条件式恢复；行锁阻止另一个维护进程在校验与写入之间改变同一 Run。
 * @param {import("mysql2/promise").Connection} database 已连接当前 Server 数据库的会话。
 * @param {string} targetRunId CLI 中已校验的唯一 Run UUID。
 * @returns {Promise<Record<string, unknown>>} 不含凭据、payload 或 Artifact 详情的恢复摘要。
 * @throws 受限前置条件不满足或任一 SQL 失败时回滚，绝不留下部分恢复状态。
 */
async function recoverRun(database, targetRunId) {
  await database.beginTransaction();
  try {
    // 步骤 1：锁定终态聚合与两个 Job；失败 Run 已不可领取，因此恢复期间没有合法 Worker 写入。
    const run = await requireSingleRow(
      database,
      "SELECT * FROM runs WHERE id = ? FOR UPDATE",
      [targetRunId],
      "RUN_NOT_FOUND",
    );
    requireFailedRunSafety(run);
    const [jobRows] = await database.execute(
      "SELECT * FROM jobs WHERE run_id = ? ORDER BY kind FOR UPDATE",
      [targetRunId],
    );
    const { professionJob, packageJob } = requireRecoverableJobs(jobRows);

    // 步骤 2：证明失败来自租约过期，或已修复且从未出站的审计表 schema 漂移；不能用裸
    // HTTP_500 绕过 Handler、证据门禁或用户业务错误。
    const finalAttempt = await requireSingleRow(
      database,
      "SELECT status, error_code AS errorCode, started_at AS startedAt, finished_at AS finishedAt FROM job_attempts WHERE job_id = ? AND attempt = ? FOR UPDATE",
      [professionJob.id, professionJob.attempt_count],
      "FINAL_ATTEMPT_NOT_FOUND",
    );
    const [activeModelRows] = await database.execute(
      "SELECT id FROM profession_skill_model_executions WHERE job_id = ? AND attempt = ? AND status IN ('prepared', 'egressing', 'persisting') FOR UPDATE",
      [professionJob.id, professionJob.attempt_count],
    );
    if (activeModelRows.length !== 0) {
      throw new Error("MODEL_EXECUTION_NOT_CLOSED");
    }
    const recoveryReason = await requireRecoverableFinalAttempt(
      database,
      targetRunId,
      professionJob,
      finalAttempt,
    );

    // 步骤 3：锁定逐技能事实。passed 行保留原 attempt/Artifact；其余仅允许可恢复中间态。
    const [skillRows] = await database.execute(
      "SELECT id, skill_id AS skillId, status FROM style_skill_productions WHERE run_id = ? ORDER BY created_at FOR UPDATE",
      [targetRunId],
    );
    const frozenSkillIds = requireFrozenSkillIds(professionJob.payload);
    const skillSummary = requireRecoverableSkills(skillRows, frozenSkillIds);

    // 步骤 4：Package 必须从未领取且没有 candidate/manifest/validation，避免覆盖真实 V3 证据。
    const stylePackage = await requireSingleRow(
      database,
      "SELECT * FROM style_packages WHERE run_id = ? FOR UPDATE",
      [targetRunId],
      "STYLE_PACKAGE_NOT_FOUND",
    );
    requireUnbuiltStylePackage(stylePackage);
    const [packageEvidenceRows] = await database.execute(
      "SELECT id FROM style_package_attempt_evidences WHERE run_id = ? FOR UPDATE",
      [targetRunId],
    );
    if (packageEvidenceRows.length !== 0) {
      throw new Error("STYLE_PACKAGE_EVIDENCE_ALREADY_EXISTS");
    }

    // 步骤 5：使用数据库 UTC 时间原子恢复状态；新 attempt 仍须由正常 claim 生成新 leaseId。
    const [timeRows] = await database.execute(
      "SELECT UTC_TIMESTAMP(3) AS databaseTime",
    );
    const databaseTime = requireDatabaseTime(timeRows[0]?.databaseTime);
    await database.execute(
      "UPDATE style_skill_productions SET job_id = NULL, worker_id = NULL, lease_id = NULL, attempt = NULL, model_call_id = NULL, image_attempt_id = NULL, aseprite_profile_id = NULL, aseprite_binary_sha256 = NULL, aseprite_adapter_sha256 = NULL, aseprite_artifact_id = NULL, aseprite_upload_id = NULL, validation_artifact_id = NULL, validation_upload_id = NULL, status = 'planned', error_code = NULL, updated_at = ?, finished_at = NULL WHERE run_id = ? AND status IN ('planned', 'generating', 'adapting', 'validating')",
      [databaseTime, targetRunId],
    );
    await database.execute(
      "UPDATE jobs SET status = 'queued', max_attempts = attempt_count + 1, dispatch_ready_at = ?, updated_at = ? WHERE id = ?",
      [databaseTime, databaseTime, professionJob.id],
    );
    await database.execute(
      "UPDATE jobs SET status = 'queued', dispatch_ready_at = NULL, updated_at = ? WHERE id = ?",
      [databaseTime, packageJob.id],
    );
    await database.execute(
      "UPDATE style_packages SET status = 'queued', finished_at = NULL, updated_at = ? WHERE run_id = ?",
      [databaseTime, targetRunId],
    );
    await database.execute(
      "UPDATE runs SET status = 'queued', current_stage = 'queued', finished_at = NULL, updated_at = ? WHERE id = ?",
      [databaseTime, targetRunId],
    );

    // 步骤 6：权威事件和 outbox 与状态同事务提交，浏览器可按 sequence 恢复这次人工操作。
    const [sequenceRows] = await database.execute(
      "SELECT COALESCE(MAX(sequence), -1) + 1 AS nextSequence FROM run_events WHERE run_id = ?",
      [targetRunId],
    );
    const sequence = requireNonNegativeInteger(
      sequenceRows[0]?.nextSequence,
      "RUN_EVENT_SEQUENCE_INVALID",
    );
    const message = recoveryEventMessage(recoveryReason, skillSummary.passed);
    const event = {
      runId: targetRunId,
      sequence,
      level: "warning",
      stage: "queued",
      message,
      createdAtUtc: mysqlUtcToIso(databaseTime),
    };
    await database.execute(
      "INSERT INTO run_events (id, run_id, sequence, level, stage, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        randomUUID(),
        targetRunId,
        sequence,
        event.level,
        event.stage,
        event.message,
        databaseTime,
      ],
    );
    await database.execute(
      "INSERT INTO outbox_events (id, topic, aggregate_id, payload, created_at) VALUES (?, 'run.event', ?, ?, ?)",
      [randomUUID(), targetRunId, JSON.stringify(event), databaseTime],
    );
    await database.commit();

    return {
      schemaVersion: 2,
      status: "requeued",
      runId: targetRunId,
      professionJobId: professionJob.id,
      recoveryReason,
      nextAttempt: Number(professionJob.attempt_count) + 1,
      preservedPassedSkills: skillSummary.passed,
      resetPendingSkills: skillSummary.pending,
      eventSequence: sequence,
      safety: {
        deploymentAuthorized: false,
        deploymentPerformed: false,
        fullSkillCoverageProven: false,
        clientCompatibilityProven: false,
      },
    };
  } catch (error) {
    await database.rollback();
    throw error;
  }
}

/**
 * 判定最后一次 attempt 的唯一可恢复原因。HTTP_500 分支只接受本次已定位的数据库 schema
 * 漂移形态；ModelCall 已创建、Provider 可能出站或 attempt 持续过久时一律拒绝。
 */
async function requireRecoverableFinalAttempt(
  database,
  targetRunId,
  professionJob,
  finalAttempt,
) {
  if (
    finalAttempt.status === "timed_out" &&
    finalAttempt.errorCode === "LEASE_EXPIRED"
  ) {
    return "lease-expired";
  }
  if (
    finalAttempt.status !== "failed" ||
    finalAttempt.errorCode !== "HTTP_500"
  ) {
    throw new Error("FINAL_ATTEMPT_NOT_RECOVERABLE");
  }

  // HTTP_500 只有在缺失的 ModelCall 遥测列已真实迁移后才可恢复，防止重试再次消耗 attempt。
  await requireModelCallTelemetryColumns(database);
  const attemptWindow = requireBoundedWindow(
    finalAttempt.startedAt,
    finalAttempt.finishedAt,
    maxSchemaFailureAttemptMs,
    "HTTP_500_ATTEMPT_WINDOW_INVALID",
  );
  const [executionRows] = await database.execute(
    "SELECT stage, status, error_code AS errorCode, model_call_id AS modelCallId, image_attempt_id AS imageAttemptId, output_artifact_id AS outputArtifactId, output_sha256 AS outputSha256, output_byte_length AS outputByteLength, created_at AS createdAt, finished_at AS finishedAt FROM profession_skill_model_executions WHERE job_id = ? AND attempt = ? FOR UPDATE",
    [professionJob.id, professionJob.attempt_count],
  );
  if (executionRows.length !== 1) {
    throw new Error("HTTP_500_EXECUTION_CARDINALITY_INVALID");
  }
  const execution = executionRows[0];
  const executionWindow = requireBoundedWindow(
    execution.createdAt,
    execution.finishedAt,
    maxSchemaFailureExecutionMs,
    "HTTP_500_EXECUTION_WINDOW_INVALID",
  );
  const evidenceEmpty = [
    execution.modelCallId,
    execution.imageAttemptId,
    execution.outputArtifactId,
    execution.outputSha256,
    execution.outputByteLength,
  ].every((value) => value === null);
  if (
    execution.stage !== "engineer-plan-v1" ||
    execution.status !== "indeterminate" ||
    execution.errorCode !== "PROFESSION_EXECUTION_ATTEMPT_CLOSED" ||
    !evidenceEmpty ||
    executionWindow.startedAtMs < attemptWindow.startedAtMs ||
    executionWindow.finishedAtMs > attemptWindow.finishedAtMs
  ) {
    throw new Error("HTTP_500_EXECUTION_NOT_RECOVERABLE");
  }
  const [modelCallRows] = await database.execute(
    "SELECT id FROM model_calls WHERE run_id = ? AND created_at >= ? AND created_at <= ? FOR UPDATE",
    [targetRunId, finalAttempt.startedAt, finalAttempt.finishedAt],
  );
  if (modelCallRows.length !== 0) {
    throw new Error("HTTP_500_MODEL_CALL_EXISTS");
  }
  return "model-call-schema-migrated";
}

/** 确认导致 ModelCall insert 失败的四个 0023 字段已经存在于当前数据库。 */
async function requireModelCallTelemetryColumns(database) {
  const [rows] = await database.execute(
    "SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'model_calls' AND column_name IN (?, ?, ?, ?)",
    modelCallTelemetryColumns,
  );
  const present = new Set(rows.map((row) => row.columnName));
  if (
    present.size !== modelCallTelemetryColumns.length ||
    modelCallTelemetryColumns.some((column) => !present.has(column))
  ) {
    throw new Error("MODEL_CALL_TELEMETRY_MIGRATION_REQUIRED");
  }
}

/** 把数据库 UTC 时间收敛为有界闭区间，避免长期或异步业务故障被误认成瞬时 schema 失败。 */
function requireBoundedWindow(startedAt, finishedAt, maximumMs, errorCode) {
  const startedAtMs = Date.parse(mysqlUtcToIso(requireDatabaseTime(startedAt)));
  const finishedAtMs = Date.parse(
    mysqlUtcToIso(requireDatabaseTime(finishedAt)),
  );
  const durationMs = finishedAtMs - startedAtMs;
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > maximumMs
  ) {
    throw new Error(errorCode);
  }
  return { startedAtMs, finishedAtMs };
}

/** 生成不含 payload、模型内容或对象引用的恢复审计消息。 */
function recoveryEventMessage(recoveryReason, passedSkillCount) {
  if (recoveryReason === "lease-expired") {
    return `Worker 控制面短暂不可用导致租约耗尽；已保留 ${String(passedSkillCount)} 项通过证据并开放一次受审计恢复。部署保持禁用。`;
  }
  return `ModelCall 审计表迁移滞后导致 Engineer 在模型出站前失败；已确认迁移字段就绪，保留 ${String(passedSkillCount)} 项通过证据并开放一次受审计恢复。部署保持禁用。`;
}

/** 校验 Run 终态与不可提升的四项安全字段。 */
function requireFailedRunSafety(run) {
  if (run.status !== "failed" || run.current_stage !== "failed") {
    throw new Error("RUN_NOT_FAILED");
  }
  const safetyValues = [
    run.deployment_authorized,
    run.deployment_performed,
    run.full_skill_coverage_proven,
    run.client_compatibility_proven,
  ];
  if (safetyValues.some((value) => Number(value) !== 0)) {
    throw new Error("RUN_SAFETY_STATE_INVALID");
  }
}

/** 从同一 Run 的两行 Job 中提取可恢复的 Profession 与尚未执行的 Package。 */
function requireRecoverableJobs(rows) {
  if (rows.length !== 2) throw new Error("RUN_JOB_CARDINALITY_INVALID");
  const professionJob = rows.find((row) => row.kind === "profession");
  const packageJob = rows.find((row) => row.kind === "npk-package");
  if (professionJob === undefined || packageJob === undefined) {
    throw new Error("RUN_JOB_KINDS_INVALID");
  }
  const professionLeaseEmpty = [
    professionJob.lease_owner_id,
    professionJob.lease_id,
    professionJob.lease_expires_at,
  ].every((value) => value === null);
  if (
    professionJob.status !== "failed" ||
    !Number.isInteger(professionJob.attempt_count) ||
    professionJob.attempt_count < 1 ||
    professionJob.attempt_count !== professionJob.max_attempts ||
    professionJob.max_attempts >= 10 ||
    !professionLeaseEmpty
  ) {
    throw new Error("PROFESSION_JOB_NOT_RECOVERABLE");
  }
  const packageLeaseEmpty = [
    packageJob.lease_owner_id,
    packageJob.lease_id,
    packageJob.lease_expires_at,
  ].every((value) => value === null);
  if (
    packageJob.status !== "failed" ||
    packageJob.attempt_count !== 0 ||
    packageJob.dispatch_ready_at !== null ||
    !packageLeaseEmpty
  ) {
    throw new Error("PACKAGE_JOB_NOT_DEFERRED");
  }
  return { professionJob, packageJob };
}

/** 从未修改的声明式 Job payload 读取冻结技能顺序，拒绝把脚本变成任意任务恢复入口。 */
function requireFrozenSkillIds(payload) {
  const value = typeof payload === "string" ? JSON.parse(payload) : payload;
  const parameters = value?.parameters;
  const skills = parameters?.promptPackage?.skills;
  if (
    value?.schemaVersion !== 1 ||
    parameters?.workflow !== "style-skill-production-v2" ||
    parameters?.deploymentAuthorized !== false ||
    !Array.isArray(skills) ||
    skills.length < 1 ||
    skills.length > 500
  ) {
    throw new Error("PROFESSION_JOB_PAYLOAD_INVALID");
  }
  const skillIds = skills.map((skill) => skill?.skillId);
  if (
    skillIds.some((skillId) => typeof skillId !== "string") ||
    new Set(skillIds).size !== skillIds.length
  ) {
    throw new Error("PROFESSION_JOB_SKILLS_INVALID");
  }
  return skillIds;
}

/** 确认逐技能集合完整，且除 passed 外只存在可安全重做的非终态。 */
function requireRecoverableSkills(rows, frozenSkillIds) {
  if (rows.length !== frozenSkillIds.length) {
    throw new Error("SKILL_PRODUCTION_CARDINALITY_INVALID");
  }
  const frozen = new Set(frozenSkillIds);
  if (
    rows.some((row) => !frozen.has(row.skillId)) ||
    new Set(rows.map((row) => row.skillId)).size !== rows.length
  ) {
    throw new Error("SKILL_PRODUCTION_IDENTITY_INVALID");
  }
  const pendingStatuses = new Set([
    "planned",
    "generating",
    "adapting",
    "validating",
  ]);
  const invalid = rows.some(
    (row) => row.status !== "passed" && !pendingStatuses.has(row.status),
  );
  if (invalid) throw new Error("SKILL_PRODUCTION_TERMINAL_FAILURE");
  const passed = rows.filter((row) => row.status === "passed").length;
  const pending = rows.length - passed;
  if (passed < 1 || pending < 1) {
    throw new Error("SKILL_PRODUCTION_RECOVERY_NOT_REQUIRED");
  }
  return { passed, pending };
}

/** Package 聚合必须没有任何 V3 输出引用，避免恢复操作覆盖 candidate/manifest/validation。 */
function requireUnbuiltStylePackage(stylePackage) {
  if (
    stylePackage.status !== "failed" ||
    stylePackage.package_artifact_id !== null ||
    stylePackage.manifest_sha256 !== null
  ) {
    throw new Error("STYLE_PACKAGE_ALREADY_BUILT");
  }
}

/** 执行必须恰好返回一行的锁定查询。 */
async function requireSingleRow(database, sql, values, errorCode) {
  const [rows] = await database.execute(sql, values);
  if (rows.length !== 1) throw new Error(errorCode);
  return rows[0];
}

/** 把 mysql2 的整数值收束为事件 sequence。 */
function requireNonNegativeInteger(value, errorCode) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(errorCode);
  return parsed;
}

/** 验证数据库时间字符串并保留 MySQL 可接受格式。 */
function requireDatabaseTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u.test(value)
  ) {
    throw new Error("DATABASE_TIME_INVALID");
  }
  return value;
}

/** 把已验证的 MySQL UTC 字符串转成公开事件使用的 ISO-8601。 */
function mysqlUtcToIso(value) {
  return new Date(`${value.replace(" ", "T")}Z`).toISOString();
}

/** CLI 只接受一个 UUID，防止维护者传入自定义状态、attempt 或 SQL 片段。 */
function parseRunId(args) {
  if (
    args.length !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      args[0] ?? "",
    )
  ) {
    throw new Error("RUN_ID_REQUIRED");
  }
  return args[0];
}

/** DATABASE_URL 仅从进程环境读取且不会进入输出或错误。 */
function requiredDatabaseUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  return value;
}

/** 只打印脚本自有稳定错误码；数据库驱动正文、连接串和堆栈一律隐藏。 */
function stableRecoveryErrorCode(error) {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message)) {
    return error.message;
  }
  return "PROFESSION_RUN_RECOVERY_FAILED";
}
