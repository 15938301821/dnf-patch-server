/**
 * @fileoverview 定义 Run 人工审核的 Drizzle 表；不执行审核状态转换、查询或 migration。
 * @module common/db/manual-review-schema
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 *
 * 调用关系：Job Repository 在共享效果验证通过后读写本表，DatabaseService 与 drizzle-kit 将其
 * 合并进统一 schema。输入是已校验且已绑定同 Run 的审核状态与 Artifact ID，输出仅为内部表定义。
 * 副作用：本文件本身不访问数据库；实际写入由调用方 transaction 完成。
 * 安全边界：证据 Artifact 必须属于同一 Run，删除采用 restrict；approved 只表示人工审核通过，
 * 不得提升 deploymentAuthorized、deploymentPerformed 或 clientCompatibilityProven。
 */
import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  foreignKey,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { artifacts, runs } from "./schema.js";

/**
 * 保存 Run 的人工审核状态与可选同 Run 证据；审核通过不等于部署或客户端兼容性已获证明。
 */
export const manualReviews = mysqlTable(
  "manual_reviews",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    runId: varchar("run_id", { length: 64 })
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 32 }).notNull(),
    reviewer: varchar("reviewer", { length: 160 }),
    evidenceArtifactId: varchar("evidence_artifact_id", { length: 64 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
  },
  (table) => [
    uniqueIndex("manual_reviews_run_uq").on(table.runId),
    foreignKey({
      columns: [table.runId, table.evidenceArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "manual_reviews_evidence_artifact_run_fk",
    }).onDelete("restrict"),
    check(
      "manual_reviews_status_ck",
      sql`${table.status} in ('pending', 'approved', 'rejected')`,
    ),
  ],
);
