import { createConnection } from "mysql2/promise";
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
  assert(
    Number(migrationRows[0].count) === 2,
    "Expected two applied migrations.",
  );
  assert(
    foreignKeys.length === 22,
    "Expected 22 foreign keys after migration.",
  );
  assert(
    foreignKeys.every((row) => row.deleteRule === "RESTRICT"),
    "Every migrated foreign key must use ON DELETE RESTRICT.",
  );
  return {
    migrationCount: Number(migrationRows[0].count),
    domainTableCount: requiredTables.length,
    foreignKeyCount: foreignKeys.length,
    allDeletesRestricted: true,
  };
}

export async function inspectDatabaseState(connection, scenario) {
  const tableNames = [
    "factories",
    "projects",
    "project_snapshots",
    "runs",
    "guardrail_decisions",
    "jobs",
    "job_attempts",
    "run_events",
    "outbox_events",
    "workers",
  ];
  const expectedRows = {
    run_events: 3,
    outbox_events: 3,
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
    "SELECT jobs.status, jobs.lease_owner_id AS leaseOwnerId, job_attempts.result_sha256 AS resultSha256 FROM jobs LEFT JOIN job_attempts ON job_attempts.job_id = jobs.id WHERE jobs.id = ?",
    [scenario.jobId],
  );
  assert(
    jobRows[0].status === "passed",
    "Completed job status was not persisted.",
  );
  assert(
    jobRows[0].leaseOwnerId === null,
    "Completed job retained its lease owner.",
  );
  assert(
    jobRows[0].resultSha256 === "A".repeat(64),
    "Attempt result hash was not normalized.",
  );
  const [runRows] = await connection.query(
    "SELECT status, deployment_authorized AS deploymentAuthorized, deployment_performed AS deploymentPerformed, full_skill_coverage_proven AS fullSkillCoverageProven, client_compatibility_proven AS clientCompatibilityProven FROM runs WHERE id = ?",
    [scenario.runId],
  );
  assert(runRows[0].status === "passed", "Run did not aggregate to passed.");
  assert(
    !runRows[0].deploymentAuthorized &&
      !runRows[0].deploymentPerformed &&
      !runRows[0].fullSkillCoverageProven &&
      !runRows[0].clientCompatibilityProven,
    "Run completion elevated an immutable safety state.",
  );
  await assertRestrictDelete(connection);
  return { ...runRows[0], rows };
}

async function assertRestrictDelete(connection) {
  try {
    await connection.query("DELETE FROM factories WHERE id = ?", [
      "runtime-factory-v1",
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
