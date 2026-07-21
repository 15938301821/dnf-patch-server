/**
 * @fileoverview 定义持久化用户与每用户认证加密模型配置表；不导出凭据 API 视图。
 * @module common/db
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan N/A（对应当前用户 BYOK 与 Run owner 直接需求）
 */
import { sql } from "drizzle-orm";
import {
  check,
  datetime,
  int,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable(
  "users",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    username: varchar("username", { length: 64 }).notNull(),
    normalizedUsername: varchar("normalized_username", {
      length: 64,
    }).notNull(),
    displayName: varchar("display_name", { length: 160 }).notNull(),
    passwordScheme: varchar("password_scheme", { length: 32 }).notNull(),
    passwordSalt: varchar("password_salt", { length: 64 }).notNull(),
    passwordHash: varchar("password_hash", { length: 128 }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("users_normalized_username_uq").on(table.normalizedUsername),
  ],
);

export const userModelConfigurations = mysqlTable(
  "user_model_configurations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: varchar("role", { length: 32 }).notNull(),
    endpoint: varchar("endpoint", { length: 500 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    credentialNonce: varchar("credential_nonce", { length: 32 }).notNull(),
    credentialTag: varchar("credential_tag", { length: 32 }).notNull(),
    credentialKeyVersion: varchar("credential_key_version", {
      length: 32,
    }).notNull(),
    version: int("version", { unsigned: true }).notNull().default(1),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("user_model_configurations_user_role_uq").on(
      table.userId,
      table.role,
    ),
    check(
      "user_model_configurations_role_ck",
      sql`${table.role} in ('orchestrator', 'spriteProcessor', 'referenceGenerator')`,
    ),
  ],
);
