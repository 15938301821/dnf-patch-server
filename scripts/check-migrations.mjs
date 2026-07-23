/**
 * @fileoverview 静态校验 Drizzle migration SQL 与 journal 一致，并禁止级联/置空删除和非 RESTRICT
 * 外键；不连接 MySQL、不执行 SQL，也不证明 migration 可在真实历史数据上成功运行。
 * @module scripts/gates
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：`npm run check:migrations` 和 gate 调用本脚本。输入是 drizzle SQL 与 meta journal，
 * 输出为文件/外键统计或错误。副作用仅读取仓库文件和写 stdout。
 * 安全边界：journal/SQL 数量必须精确一致，所有新增外键必须显式 `ON DELETE RESTRICT`；通过仍不
 * 证明 SQL 已应用、CHECK 被 MySQL 接受或历史审计数据满足 migrate.ts 的 fail-closed 预检。
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Drizzle 生成 migration 的仓库目录。 */
const migrationRoot = resolve("drizzle");
/** drizzle-kit journal 路径，是 migration 顺序与 tag 的静态事实源。 */
const journalPath = resolve(migrationRoot, "meta", "_journal.json");
// 步骤 1：先解析 journal 结构；缺少 entries 时不能继续比较并必须失败。
const journal = JSON.parse(await readFile(journalPath, "utf8"));
if (!Array.isArray(journal.entries)) {
  throw new Error("Drizzle migration journal has no entries array.");
}
const sqlFiles = (await readdir(migrationRoot))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
  .sort();
const journalFiles = journal.entries.map((entry) => `${entry.tag}.sql`).sort();
// 步骤 2：SQL 文件集合必须与 journal tag 精确相等，拒绝漏记或悬空 migration。
if (JSON.stringify(sqlFiles) !== JSON.stringify(journalFiles)) {
  throw new Error(
    `Migration SQL and journal differ: ${JSON.stringify({ sqlFiles, journalFiles })}`,
  );
}

let foreignKeyCount = 0;
// 步骤 3：逐条静态检查删除语义；限制性外键避免生命周期删除悄然移除审计证据。
for (const file of sqlFiles) {
  const sql = await readFile(resolve(migrationRoot, file), "utf8");
  if (/ON\s+DELETE\s+(?:CASCADE|SET\s+NULL)/iu.test(sql)) {
    throw new Error(`Migration contains destructive delete behavior: ${file}`);
  }
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (!/ADD\s+CONSTRAINT[\s\S]*FOREIGN\s+KEY/iu.test(statement)) {
      continue;
    }
    foreignKeyCount += 1;
    if (!/ON\s+DELETE\s+restrict/iu.test(statement)) {
      throw new Error(`Foreign key is not delete-restrictive in ${file}.`);
    }
  }
}
if (foreignKeyCount === 0) {
  throw new Error("No database foreign keys were found in migrations.");
}
// 步骤 4：仅报告静态一致性统计，不声称 migration 已在 MySQL 执行。
process.stdout.write(
  `${JSON.stringify({ status: "passed", migrationCount: sqlFiles.length, journalEntryCount: journalFiles.length, foreignKeyCount }, null, 2)}\n`,
);
