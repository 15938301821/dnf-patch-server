/**
 * @fileoverview 执行 Drizzle migration，并在审计字段升级前阻断无法证明事实的历史数据。
 * @module database
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：`npm run db:migrate` 直接执行本 CLI；脚本先用单连接检查历史审计数据，再交给 Drizzle
 * migrator 读取 drizzle/。输入只有进程 DATABASE_URL 与数据库现状，无 HTTP/Worker 输入；输出是
 * migration 成功或进程错误。副作用包括读取 information_schema、执行 migration 并关闭连接池。
 * 安全边界：无法证明历史 ModelCall egress 或 NPK inventory producing Run 时必须 fail-closed，
 * 禁止猜测回填；连接 URL、SQL 驱动对象和历史内容不得进入输出。
 */
import "reflect-metadata";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import {
  createPool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

/** 固定 COUNT 查询的数据库行；驱动可能把数值返回为 number 或 string。 */
interface CountRow extends RowDataPacket {
  /** SQL `COUNT(*)` 结果，使用前还需转换并检查非负安全整数。 */
  count: number | string;
}

/** migration CLI 的唯一连接配置；缺失时在创建连接池前中止。 */
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
  // 步骤 1：借用同一数据库连接执行只读预检；任一失败时不得进入 Drizzle migration。
  const connection = await pool.getConnection();
  try {
    await assertNpkInventoryOwnershipMigrationReady(connection);
    await assertModelCallEgressMigrationReady(connection);
  } finally {
    connection.release();
  }
  // 步骤 2：所有历史数据可安全演进后才执行版本化 SQL；Drizzle 负责 migration 事务/记录语义。
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
} finally {
  // 步骤 3：成功或异常都关闭单连接池，避免 CLI 进程悬挂；关闭不吞掉原始失败。
  await pool.end();
}

/**
 * 在新增实际 egress 字段前检查旧 ModelCall 是否为空。
 * 历史调用无法仅凭授权和终态推断是否真正发出请求，因此禁止默认回填 false。
 *
 * @param connection CLI 从目标 MySQL 池借用的连接，只执行固定内部 SQL，不含外部插值。
 * @returns 表不存在、字段已迁移或旧表为空时完成。
 * @throws Error 旧表有记录但缺少 egress 字段时抛出 `MODEL_CALL_EGRESS_MIGRATION_BLOCKED`；
 * 查询结果异常时抛出预检错误，migration 不会执行。
 */
export async function assertModelCallEgressMigrationReady(
  connection: PoolConnection,
): Promise<void> {
  // 步骤 1：新数据库没有旧表，无历史事实需要回填。
  const tableExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'model_calls'",
    )) > 0;
  if (!tableExists) return;

  // 步骤 2：字段已存在表示对应演进已完成，本次无需重复审计旧行。
  const performedColumnExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'model_calls' AND column_name = 'model_egress_performed'",
    )) > 0;
  if (performedColumnExists) return;

  // 步骤 3：字段缺失时只允许空表演进；任何历史调用都无法可靠推断实际外发状态。
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
 *
 * @param connection CLI 从目标 MySQL 池借用的连接，只执行固定内部 SQL。
 * @returns 表不存在、run_id 已存在或旧表为空时完成。
 * @throws Error 旧 inventory 存在但缺少 run_id 时抛出
 * `NPK_INVENTORY_RUN_OWNERSHIP_MIGRATION_BLOCKED`，migration 不会执行。
 */
export async function assertNpkInventoryOwnershipMigrationReady(
  connection: PoolConnection,
): Promise<void> {
  // 步骤 1：没有旧表时由 migration 正常创建，无历史来源归属需要推断。
  const tableExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'npk_inventories'",
    )) > 0;
  if (!tableExists) return;

  // 步骤 2：run_id 已存在表示 producing Run 归属字段已完成演进。
  const runColumnExists =
    (await scalarCount(
      connection,
      "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'npk_inventories' AND column_name = 'run_id'",
    )) > 0;
  if (runColumnExists) return;

  // 步骤 3：旧表非空时拒绝无证据回填，避免伪造 inventory 的 Run/Project 来源链。
  const inventoryCount = await scalarCount(
    connection,
    "SELECT COUNT(*) AS count FROM `npk_inventories`",
  );
  if (inventoryCount > 0) {
    throw new Error("NPK_INVENTORY_RUN_OWNERSHIP_MIGRATION_BLOCKED");
  }
}

/**
 * 执行固定 COUNT SQL 并把 mysql2 的 number/string 结果收敛为安全整数。
 * @param connection 当前 migration 预检连接。
 * @param statement 仅由本文件定义的无外部插值 COUNT 语句；不得传入用户输入。
 * @returns 非负安全整数计数。
 * @throws Error 响应缺失、类型异常、非整数、负数或溢出时抛出 `MIGRATION_PRECHECK_INVALID_RESULT`。
 */
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
