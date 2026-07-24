/**
 * @fileoverview 定义风格 Run 的候选包聚合表；不保存候选 NPK 正文、不授权部署，也不证明
 * 客户端兼容。对象正文仍位于私有对象存储，数据库只保存同 Run Artifact 引用和摘要。
 * @module common/db/style-package-schema
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：PatchTask Repository 在 transaction 中创建和更新，DatabaseService 与 drizzle-kit
 * 将本文件并入统一 schema；审核与下载流程只消费 passed 记录的证据引用。
 * 输入输出：输入已校验的职业/风格/Run/Artifact 标识与状态，输出仅为内部数据库行。
 * 安全边界：passed 必须具备同 Run package Artifact、manifest SHA-256 与 finishedAt；限制性外键
 * 不能放宽，候选包存在不能提升 deploymentAuthorized 或 clientCompatibilityProven。
 */
import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  foreignKey,
  index,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { artifacts, runs } from "./schema.js";
import { professionStyles } from "./studio-schema.js";

/**
 * 风格 Run 的候选包聚合状态；passed 只证明候选对象与清单证据已记录，不代表部署或兼容。
 */
export const stylePackages = mysqlTable(
  "style_packages",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    professionId: varchar("profession_id", { length: 64 }).notNull(),
    styleId: varchar("style_id", { length: 64 }).notNull(),
    runId: varchar("run_id", { length: 64 })
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    /** 同一 runId 下的候选包 Artifact，只有 passed 时要求非空。 */
    packageArtifactId: varchar("package_artifact_id", { length: 64 }),
    manifestSha256: varchar("manifest_sha256", { length: 64 }),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
    finishedAt: datetime("finished_at", { mode: "date", fsp: 3 }),
  },
  (table) => [
    index("style_packages_style_idx").on(table.styleId),
    uniqueIndex("style_packages_run_uq").on(table.runId),
    check(
      "style_packages_status_ck",
      sql`${table.status} in ('queued', 'building', 'passed', 'failed', 'blocked')`,
    ),
    check(
      "style_packages_passed_evidence_ck",
      sql`${table.status} <> 'passed' or (${table.packageArtifactId} is not null and ${table.manifestSha256} is not null and ${table.finishedAt} is not null)`,
    ),
    foreignKey({
      columns: [table.professionId, table.styleId],
      foreignColumns: [professionStyles.professionId, professionStyles.id],
      name: "style_packages_style_profession_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runId, table.packageArtifactId],
      foreignColumns: [artifacts.runId, artifacts.id],
      name: "style_packages_artifact_run_fk",
    }).onDelete("restrict"),
  ],
);
