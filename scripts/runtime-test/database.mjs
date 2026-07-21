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
  "workers",
];

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

export function connectDatabase(port) {
  return createConnection({
    host,
    port,
    user: "root",
    database: databaseName,
  });
}

export async function inspectSchema(connection) {
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
  const requiredColumns = [
    "job_attempts.lease_id",
    "jobs.dispatch_ready_at",
    "jobs.lease_id",
    "model_calls.model_egress_performed",
    "npk_inventories.run_id",
    "runs.request_fingerprint_sha256",
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
    requiredColumnCount: requiredColumns.length,
    requiredCheckCount: requiredChecks.length,
    allDeletesRestricted: true,
  };
}

export async function inspectDatabaseState(connection, scenario) {
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
  await assertEvidenceOwnership(connection, scenario);
  await assertCheckConstraints(connection, scenario);
  await assertRestrictDelete(connection);
  return { ...runRows[0], rows };
}

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
