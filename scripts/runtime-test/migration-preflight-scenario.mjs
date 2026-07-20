/**
 * @fileoverview 在真实 MySQL 中验证历史审计字段 migration 的 fail-closed preflight。
 * @module runtime-test
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 3 migration evidence
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createConnection } from "mysql2/promise";
import { assert, errorMessage, runProcess } from "./process.mjs";

const host = "127.0.0.1";

/** 使用正式 migration 入口验证两类不可证明历史数据均被阻断。 */
export async function exerciseMigrationPreflight(port) {
  const suffix = randomBytes(4).toString("hex");
  const cases = [
    {
      databaseName: `dnf_patch_legacy_npk_${suffix}`,
      table: "npk_inventories",
      errorCode: "NPK_INVENTORY_RUN_OWNERSHIP_MIGRATION_BLOCKED",
    },
    {
      databaseName: `dnf_patch_legacy_model_${suffix}`,
      table: "model_calls",
      errorCode: "MODEL_CALL_EGRESS_MIGRATION_BLOCKED",
    },
  ];
  const admin = await createConnection({ host, port, user: "root" });
  try {
    for (const migrationCase of cases) {
      await createLegacyTable(admin, port, migrationCase);
      await assertMigrationBlocked(port, migrationCase);
    }
  } finally {
    for (const migrationCase of cases) {
      await admin.query(
        `DROP DATABASE IF EXISTS \`${migrationCase.databaseName}\``,
      );
    }
    await admin.end();
  }
  return {
    legacyNpkBlocked: true,
    legacyModelCallBlocked: true,
  };
}

async function createLegacyTable(admin, port, migrationCase) {
  await admin.query(
    `CREATE DATABASE \`${migrationCase.databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  const connection = await createConnection({
    host,
    port,
    user: "root",
    database: migrationCase.databaseName,
  });
  try {
    await connection.query(
      `CREATE TABLE \`${migrationCase.table}\` (id CHAR(36) NOT NULL PRIMARY KEY)`,
    );
    await connection.query(
      `INSERT INTO \`${migrationCase.table}\` (id) VALUES ('legacy-row')`,
    );
  } finally {
    await connection.end();
  }
}

async function assertMigrationBlocked(port, migrationCase) {
  const databaseUrl = `mysql://root@${host}:${String(port)}/${migrationCase.databaseName}`;
  try {
    await runProcess(process.execPath, [resolve("dist/common/db/migrate.js")], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeoutMs: 60_000,
    });
  } catch (error) {
    const output = errorMessage(error);
    assert(
      output.includes(migrationCase.errorCode),
      `Legacy ${migrationCase.table} migration failed without ${migrationCase.errorCode}.`,
    );
    return;
  }
  throw new Error(`Legacy ${migrationCase.table} migration was not blocked.`);
}
