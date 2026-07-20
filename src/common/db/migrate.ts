/**
 * @fileoverview 执行 Drizzle migration，并在审计字段升级前阻断无法证明事实的历史数据。
 * @module database
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 1 evidence ownership
 */
import "reflect-metadata";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import {
  createPool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

interface CountRow extends RowDataPacket {
  count: number | string;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for migration.");
}

const pool = createPool({
  uri: databaseUrl,
  connectionLimit: 1,
  timezone: "Z",
});
try {
  const connection = await pool.getConnection();
  try {
    await assertNpkInventoryOwnershipMigrationReady(connection);
    await assertModelCallEgressMigrationReady(connection);
  } finally {
    connection.release();
  }
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
} finally {
  await pool.end();
}

/**
 * 在新增实际 egress 字段前检查旧 ModelCall 是否为空。
 * 历史调用无法仅凭授权和终态推断是否真正发出请求，因此禁止默认回填 false。
 */
export async function assertModelCallEgressMigrationReady(
  connection: PoolConnection,
): Promise<void> {
  const tableExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'model_calls'",
    )) > 0;
  if (!tableExists) return;

  const performedColumnExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'model_calls' AND column_name = 'model_egress_performed'",
    )) > 0;
  if (performedColumnExists) return;

  const modelCallCount = await scalarCount(
    connection,
    "SELECT COUNT(*) AS count FROM `model_calls`",
  );
  if (modelCallCount > 0) {
    throw new Error("MODEL_CALL_EGRESS_MIGRATION_BLOCKED");
  }
}

/**
 * 在新增非空 producing Run 前检查旧 inventory 是否可安全迁移。
 * 已有 inventory 行但没有来源证据时直接失败，禁止猜测、回填或改变审计记录。
 */
export async function assertNpkInventoryOwnershipMigrationReady(
  connection: PoolConnection,
): Promise<void> {
  const tableExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'npk_inventories'",
    )) > 0;
  if (!tableExists) return;

  const runColumnExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'npk_inventories' AND column_name = 'run_id'",
    )) > 0;
  if (runColumnExists) return;

  const inventoryCount = await scalarCount(
    connection,
    "SELECT COUNT(*) AS count FROM `npk_inventories`",
  );
  if (inventoryCount > 0) {
    throw new Error("NPK_INVENTORY_RUN_OWNERSHIP_MIGRATION_BLOCKED");
  }
}

async function scalarCount(
  connection: PoolConnection,
  statement: string,
): Promise<number> {
  const [rows] = await connection.query<CountRow[]>(statement);
  const value = rows[0]?.count;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("MIGRATION_PRECHECK_INVALID_RESULT");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("MIGRATION_PRECHECK_INVALID_RESULT");
  }
  return count;
}
