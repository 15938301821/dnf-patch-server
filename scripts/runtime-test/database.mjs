/**
 * @fileoverview 管理隔离 MySQL runtime 实例并核验真实 migration、约束与持久化状态；不连接系统 3306、不修改生产数据库，也不证明外部服务集成。
 * @module scripts/runtime-test
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 * 调用关系：test-mysql-runtime 调用初始化/启动/检查函数，下游仅使用 process.mjs 与 mysql2；输入是已校验 mysqld 身份、临时目录/端口和 scenario ID，输出为连接、schema/行数摘要。
 * 副作用与边界：创建临时无密码 root 实例仅绑定回环、执行真实 SQL/migration 并由上层清理；固定 SQL 不接收 HTTP 输入。通过只证明当前 MySQL 版本和场景，不证明生产备份、升级或多副本并发。
 */
import { createConnection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assert,
  assertRunning,
  delay,
  processFailure,
  runProcess,
  startProcess,
} from "./process.mjs";

const host = "127.0.0.1";
/** 隔离实例固定数据库名，仅存在于 runtime 临时 data directory。 */
export const databaseName = "dnf_patch_runtime";
const requiredTables = [
  "artifacts",
  "factories",
  "guardrail_decisions",
  "image_attempts",
  "job_attempts",
  "jobs",
  "manual_reviews",
  "model_calls",
  "npk_inventories",
  "npk_inventory_entries",
  "outbox_events",
  "project_snapshots",
  "projects",
  "run_events",
  "runs",
  "style_skill_productions",
  "workers",
];
/** @param identity 已校验 mysqld 身份；@param dataPath 新建临时数据目录。@returns `--initialize-insecure` 成功后完成。@throws 初始化超时或非零退出时抛出；该无密码实例只允许回环测试。 */
export async function initializeMysql(identity, dataPath) {
  await runProcess(
    identity.path,
    [
      "--no-defaults",
      "--initialize-insecure",
      "--console",
      `--basedir=${identity.basedir}`,
      `--datadir=${dataPath}`,
    ],
    { timeoutMs: 120_000 },
  );
}
/** @param identity 已校验 mysqld；@param dataPath 临时数据目录；@param port 回环空闲端口；@param workingPath 临时工作目录。@returns 关闭网络扩展/本地导入/文件导出的 mysqld 句柄。 */
export function startMysql(identity, dataPath, port, workingPath) {
  return startProcess(
    identity.path,
    [
      "--no-defaults",
      "--console",
      `--basedir=${identity.basedir}`,
      `--datadir=${dataPath}`,
      `--port=${String(port)}`,
      `--bind-address=${host}`,
      "--mysqlx=OFF",
      "--skip-log-bin",
      "--local-infile=OFF",
      "--secure-file-priv=NULL",
      `--pid-file=${workingPath}/mysqld.pid`,
    ],
    { cwd: workingPath },
  );
}
/** @param processHandle 隔离 mysqld；@param port 回环端口。@returns 30 秒内可建立 root 连接时完成。@throws 进程提前退出或截止时仍不可用时抛出脱敏错误。 */
export async function waitForMysql(processHandle, port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertRunning(processHandle, "Isolated MySQL");
    try {
      const connection = await createConnection({
        host,
        port,
        user: "root",
        connectTimeout: 1_000,
      });
      await connection.end();
      return;
    } catch {
      await delay(100);
    }
  }
  throw processFailure(
    processHandle,
    "Isolated MySQL did not start in 30 seconds.",
  );
}
/** @param port 隔离 MySQL 端口。@returns 新建 utf8mb4 数据库的无密码回环 URL，仅传给测试子进程。@throws CREATE DATABASE 失败时传播并始终关闭 admin 连接。 */
export async function createDatabase(port) {
  const admin = await createConnection({ host, port, user: "root" });
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } finally {
    await admin.end();
  }
  return `mysql://root@${host}:${String(port)}/${databaseName}`;
}
/** @param port 隔离 MySQL 端口。@returns 指向 runtime 数据库的 mysql2 连接 Promise；调用方负责 end。 */
export function connectDatabase(port) {
  return createConnection({
    host,
    port,
    user: "root",
    database: databaseName,
  });
}
/** @param connection 已执行 migration 的隔离数据库连接。@returns migration/表/外键/列/CHECK 统计。@throws 任一必需结构缺失、journal 数不符或删除规则非 RESTRICT 时抛出。 */
export async function inspectSchema(connection) {
  // 步骤 1：核对领域表与 Drizzle journal 实际应用数量，不以 SQL 文件存在代替执行证明。
  const [tableRows] = await connection.query(
    "SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
    [databaseName],
  );
  const tableNames = tableRows.map((row) => row.tableName);
  for (const table of requiredTables) {
    assert(
      tableNames.includes(table),
      `Migrated schema is missing table ${table}.`,
    );
  }
  const [migrationRows] = await connection.query(
    "SELECT COUNT(*) AS count FROM `__drizzle_migrations`",
  );
  const [foreignKeys] = await connection.query(
    "SELECT constraint_name AS constraintName, delete_rule AS deleteRule FROM information_schema.referential_constraints WHERE constraint_schema = ?",
    [databaseName],
  );
  const journal = JSON.parse(
    await readFile(resolve("drizzle/meta/_journal.json"), "utf8"),
  );
  assert(
    Number(migrationRows[0].count) === journal.entries.length,
    "Applied migrations do not match the Drizzle journal.",
  );
  assert(foreignKeys.length > 0, "Expected migrated foreign keys.");
  assert(
    foreignKeys.every((row) => row.deleteRule === "RESTRICT"),
    "Every migrated foreign key must use ON DELETE RESTRICT.",
  );
  const foreignKeyNames = new Set(foreignKeys.map((row) => row.constraintName));
  const requiredForeignKeys = [
    "style_skill_productions_worker_id_workers_id_fk",
    "style_skill_productions_attempt_lease_fk",
    "style_skill_productions_aseprite_upload_fk",
    "style_skill_productions_validation_upload_fk",
  ];
  for (const foreignKey of requiredForeignKeys) {
    assert(
      foreignKeyNames.has(foreignKey),
      `Migrated schema is missing foreign key ${foreignKey}.`,
    );
  }
  // 步骤 2：核对租约、审计归属和请求指纹的关键列，再核对数据库实际 CHECK 元数据。
  const requiredColumns = [
    "job_attempts.lease_id",
    "jobs.dispatch_ready_at",
    "jobs.lease_id",
    "model_calls.model_egress_performed",
    "npk_inventories.run_id",
    "runs.request_fingerprint_sha256",
    "style_skill_productions.worker_id",
    "style_skill_productions.lease_id",
    "style_skill_productions.attempt",
    "style_skill_productions.aseprite_adapter_sha256",
    "style_skill_productions.aseprite_upload_id",
    "style_skill_productions.validation_upload_id",
    "style_skill_productions.error_code",
  ];
  const [columnRows] = await connection.query(
    "SELECT table_name AS tableName, column_name AS columnName FROM information_schema.columns WHERE table_schema = ?",
    [databaseName],
  );
  const columns = new Set(
    columnRows.map((row) => `${row.tableName}.${row.columnName}`),
  );
  for (const column of requiredColumns) {
    assert(columns.has(column), `Migrated schema is missing column ${column}.`);
  }
  const requiredChecks = [
    "job_attempts_status_ck",
    "jobs_attempt_limit_ck",
    "jobs_lease_fields_ck",
    "jobs_status_ck",
    "model_calls_egress_ck",
    "model_calls_finished_ck",
    "model_calls_status_ck",
    "project_snapshots_safety_state_ck",
    "runs_safety_state_ck",
    "runs_status_ck",
    "style_skill_productions_error_evidence_ck",
    "style_skill_productions_passed_evidence_ck",
  ];
  const [checkRows] = await connection.query(
    "SELECT constraint_name AS constraintName FROM information_schema.check_constraints WHERE constraint_schema = ?",
    [databaseName],
  );
  const checks = new Set(checkRows.map((row) => row.constraintName));
  for (const check of requiredChecks) {
    assert(checks.has(check), `Migrated schema is missing CHECK ${check}.`);
  }
  return {
    migrationCount: Number(migrationRows[0].count),
    domainTableCount: requiredTables.length,
    foreignKeyCount: foreignKeys.length,
    requiredForeignKeyCount: requiredForeignKeys.length,
    requiredColumnCount: requiredColumns.length,
    requiredCheckCount: requiredChecks.length,
    allDeletesRestricted: true,
  };
}
/** @param connection 场景完成后的隔离连接；@param scenario exerciseApi 返回的权威 ID。@returns Run 安全状态与各表精确行数。@throws 状态聚合、租约清理、证据归属或数据库约束任一不符时抛出。 */
export async function inspectDatabaseState(connection, scenario) {
  // 步骤 1：先锁定预期持久化集合，避免场景静默多写/少写权威事件或 attempt。
  const tableNames = [
    "artifacts",
    "factories",
    "projects",
    "project_snapshots",
    "runs",
    "guardrail_decisions",
    "jobs",
    "job_attempts",
    "run_events",
    "outbox_events",
    "npk_inventories",
    "npk_inventory_entries",
    "workers",
  ];
  const expectedRows = {
    artifacts: 1,
    runs: 3,
    guardrail_decisions: 3,
    jobs: 3,
    job_attempts: 3,
    run_events: 9,
    outbox_events: 9,
    npk_inventories: 1,
    npk_inventory_entries: 1,
  };
  const rows = {};
  for (const table of tableNames) {
    const [counts] = await connection.query(
      `SELECT COUNT(*) AS count FROM \`${table}\``,
    );
    rows[table] = Number(counts[0].count);
    const expected = expectedRows[table] ?? 1;
    assert(
      rows[table] === expected,
      `Expected ${String(expected)} persisted rows in ${table}.`,
    );
  }
  const [jobRows] = await connection.query(
    "SELECT jobs.status, jobs.lease_owner_id AS leaseOwnerId, jobs.lease_id AS leaseId, jobs.lease_expires_at AS leaseExpiresAt, job_attempts.result_sha256 AS resultSha256 FROM jobs LEFT JOIN job_attempts ON job_attempts.job_id = jobs.id WHERE jobs.id = ?",
    [scenario.jobId],
  );
  assert(
    jobRows[0].status === "passed",
    "Completed job status was not persisted.",
  );
  assert(
    jobRows[0].leaseOwnerId === null &&
      jobRows[0].leaseId === null &&
      jobRows[0].leaseExpiresAt === null,
    "Completed job retained lease fields.",
  );
  assert(
    jobRows[0].resultSha256 === "A".repeat(64),
    "Attempt result hash was not normalized.",
  );
  const [retryJobRows] = await connection.query(
    "SELECT status, attempt_count AS attemptCount, lease_owner_id AS leaseOwnerId, lease_id AS leaseId, lease_expires_at AS leaseExpiresAt FROM jobs WHERE id = ?",
    [scenario.retryJobId],
  );
  assert(
    retryJobRows[0].status === "failed" &&
      retryJobRows[0].attemptCount === 2 &&
      retryJobRows[0].leaseOwnerId === null &&
      retryJobRows[0].leaseId === null &&
      retryJobRows[0].leaseExpiresAt === null,
    "Reaper did not fail the exhausted job and clear its lease.",
  );
  const [retryAttempts] = await connection.query(
    "SELECT attempt, status, error_code AS errorCode, finished_at AS finishedAt FROM job_attempts WHERE job_id = ? ORDER BY attempt",
    [scenario.retryJobId],
  );
  assert(
    retryAttempts.length === 2 &&
      retryAttempts.every(
        (attempt, index) =>
          attempt.attempt === index + 1 &&
          attempt.status === "timed_out" &&
          attempt.errorCode === "LEASE_EXPIRED" &&
          attempt.finishedAt !== null,
      ),
    "Expired attempts were not closed as timed_out.",
  );
  const [runRows] = await connection.query(
    "SELECT status, request_fingerprint_sha256 AS requestFingerprintSha256, deployment_authorized AS deploymentAuthorized, deployment_performed AS deploymentPerformed, full_skill_coverage_proven AS fullSkillCoverageProven, client_compatibility_proven AS clientCompatibilityProven FROM runs WHERE id = ?",
    [scenario.runId],
  );
  assert(runRows[0].status === "passed", "Run did not aggregate to passed.");
  assert(
    typeof runRows[0].requestFingerprintSha256 === "string" &&
      runRows[0].requestFingerprintSha256.length === 64,
    "Run request fingerprint was not persisted.",
  );
  assert(
    !runRows[0].deploymentAuthorized &&
      !runRows[0].deploymentPerformed &&
      !runRows[0].fullSkillCoverageProven &&
      !runRows[0].clientCompatibilityProven,
    "Run completion elevated an immutable safety state.",
  );
  const [retryRunRows] = await connection.query(
    "SELECT status, finished_at AS finishedAt FROM runs WHERE id = ?",
    [scenario.retryRunId],
  );
  assert(
    retryRunRows[0].status === "failed" && retryRunRows[0].finishedAt !== null,
    "Exhausted job did not aggregate its Run to failed.",
  );
  const [integrityRows] = await connection.query(
    "SELECT jobs.status AS jobStatus, jobs.lease_owner_id AS leaseOwnerId, jobs.lease_id AS leaseId, jobs.lease_expires_at AS leaseExpiresAt, runs.status AS runStatus FROM jobs INNER JOIN runs ON runs.id = jobs.run_id WHERE jobs.id = ? AND runs.id = ?",
    [scenario.integrityJobId, scenario.integrityRunId],
  );
  assert(
    integrityRows.length === 1 &&
      integrityRows[0].jobStatus === "blocked" &&
      integrityRows[0].runStatus === "blocked" &&
      integrityRows[0].leaseOwnerId === null &&
      integrityRows[0].leaseId === null &&
      integrityRows[0].leaseExpiresAt === null,
    "Tampered Job did not remain quarantined after restart.",
  );
  // 步骤 2：主动提交非法 SQL，证明复合外键、CHECK 与 RESTRICT 在真实 MySQL 生效。
  await assertEvidenceOwnership(connection, scenario);
  await assertCheckConstraints(connection, scenario);
  await assertRestrictDelete(connection);
  return { ...runRows[0], rows };
}
/** @param connection 隔离连接；@param scenario 场景 ID。@returns 同 Run Artifact/Inventory 归属与跨 Run 外键拒绝均成立时完成。@throws 证据链漂移或非法插入被接受时抛出。 */
async function assertEvidenceOwnership(connection, scenario) {
  const [artifactRows] = await connection.query(
    "SELECT run_id AS runId FROM artifacts WHERE id = ?",
    [scenario.artifactId],
  );
  const [inventoryRows] = await connection.query(
    "SELECT project_id AS projectId, run_id AS runId, inventory_artifact_id AS inventoryArtifactId, entry_count AS entryCount FROM npk_inventories WHERE id = ?",
    [scenario.inventoryId],
  );
  assert(
    artifactRows.length === 1 && artifactRows[0].runId === scenario.runId,
    "Artifact producing Run ownership was not persisted.",
  );
  assert(
    inventoryRows.length === 1 &&
      inventoryRows[0].projectId === scenario.projectId &&
      inventoryRows[0].runId === scenario.runId &&
      inventoryRows[0].inventoryArtifactId === scenario.artifactId &&
      inventoryRows[0].entryCount === 1,
    "NPK inventory ownership evidence was not persisted.",
  );
  await assertForeignKeyRejects(
    connection,
    "INSERT INTO run_events (id, run_id, sequence, level, stage, message, evidence_artifact_id, created_at) VALUES ('runtime-cross-run-event', ?, 99, 'info', 'evidence', 'Cross-Run evidence must be rejected.', ?, CURRENT_TIMESTAMP(3))",
    [scenario.retryRunId, scenario.artifactId],
  );
}
/** @param connection 隔离连接。@returns 被引用 Factory 删除收到 ER_ROW_IS_REFERENCED_2 时完成。@throws 删除成功或返回其他错误时抛出。 */
async function assertRestrictDelete(connection) {
  try {
    await connection.query("DELETE FROM factories WHERE id = ?", [
      "runtime-factory-v2",
    ]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      error.code === "ER_ROW_IS_REFERENCED_2"
    ) {
      return;
    }
    throw error;
  }
  throw new Error("ON DELETE RESTRICT did not protect the referenced factory.");
}
/** @param connection 隔离连接；@param scenario 当前 Run/Job/Snapshot ID。@returns 所有非法状态更新均被 CHECK 拒绝时完成。@throws 任一 CHECK 缺失或返回非预期驱动错误时抛出。 */
async function assertCheckConstraints(connection, scenario) {
  await assertCheckRejects(
    connection,
    "UPDATE runs SET deployment_authorized = true WHERE id = ?",
    [scenario.runId],
  );
  await assertCheckRejects(
    connection,
    "UPDATE project_snapshots SET full_skill_coverage_proven = true WHERE id = ?",
    [scenario.snapshotId],
  );
  await assertCheckRejects(
    connection,
    "UPDATE runs SET status = 'invalid' WHERE id = ?",
    [scenario.runId],
  );
  await assertCheckRejects(
    connection,
    "UPDATE jobs SET lease_id = 'invalid-lease' WHERE id = ?",
    [scenario.jobId],
  );
  await assertCheckRejects(
    connection,
    "UPDATE jobs SET attempt_count = max_attempts + 1 WHERE id = ?",
    [scenario.jobId],
  );
  await assertCheckRejects(
    connection,
    "UPDATE job_attempts SET status = 'invalid' WHERE job_id = ?",
    [scenario.jobId],
  );
  await assertModelCallChecks(connection, scenario.runId);
}
/** @param connection 隔离连接；@param runId 当前 Run。@returns ModelCall 状态、egress 与 finishedAt CHECK 均生效后完成；插入的测试行保留供行数核验。 */
async function assertModelCallChecks(connection, runId) {
  const id = "runtime-model-call-check";
  await connection.query(
    "INSERT INTO model_calls (id, run_id, role, model, endpoint_identity, request_sha256, status, model_egress_authorized, model_egress_performed, created_at) VALUES (?, ?, 'engineer', 'runtime-model', 'runtime.invalid/v1', ?, 'running', true, false, CURRENT_TIMESTAMP(3))",
    [id, runId, "D".repeat(64)],
  );
  await assertCheckRejects(
    connection,
    "UPDATE model_calls SET status = 'invalid' WHERE id = ?",
    [id],
  );
  await assertCheckRejects(
    connection,
    "UPDATE model_calls SET model_egress_authorized = false, model_egress_performed = true WHERE id = ?",
    [id],
  );
  await assertCheckRejects(
    connection,
    "UPDATE model_calls SET status = 'failed' WHERE id = ?",
    [id],
  );
  await connection.query(
    "UPDATE model_calls SET status = 'abandoned', error_code = 'MODEL_CALL_ABANDONED_AFTER_RESTART', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [id],
  );
}
/** @param connection 隔离连接；@param statement 本文件固定非法 SQL；@param parameters 场景 ID。@returns 收到 MySQL CHECK 违反码时完成。@throws SQL 被接受或错误类型不匹配时抛出。 */
async function assertCheckRejects(connection, statement, parameters) {
  try {
    await connection.query(statement, parameters);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error.code === "ER_CHECK_CONSTRAINT_VIOLATED" || error.errno === 3819)
    ) {
      return;
    }
    throw error;
  }
  throw new Error("A database CHECK constraint accepted invalid state.");
}
/** @param connection 隔离连接；@param statement 本文件固定跨 Run SQL；@param parameters 场景 ID。@returns 收到外键违反码时完成。@throws SQL 被接受或错误类型不匹配时抛出。 */
async function assertForeignKeyRejects(connection, statement, parameters) {
  try {
    await connection.query(statement, parameters);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      (error.code === "ER_NO_REFERENCED_ROW_2" || error.errno === 1452)
    ) {
      return;
    }
    throw error;
  }
  throw new Error("A composite foreign key accepted cross-Run evidence.");
}
