/**
 * @fileoverview 定义持久化用户与每用户认证加密模型配置表；不导出凭据 API 视图。
 * @module common/db
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Auth/ModelConfiguration Repository 在 transaction 中读写这些表，schema.ts 统一
 * 重导出供其他表建立用户外键；Drizzle migration 消费定义。输入是已校验用户注册数据和认证
 * 加密结果，输出是内部持久化行。副作用由 Repository 执行，不形成对外 ViewModel。
 * 安全边界：密码只保存带 scheme/salt 的派生 hash；BYOK 密钥明文不得入库，密文、nonce、tag、
 * keyVersion 必须作为同一 AES-256-GCM 组合写入，并绑定稳定 userId/role 所有权且 fail-closed 解密。
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

/**
 * 持久化用户身份表；生产方是注册/认证 Repository，消费方是会话签发、Run owner 与模型配置。
 * normalizedUsername 是唯一登录键，displayName 仅展示；passwordScheme、salt、hash 必须由同一次
 * 密码派生流程生成，任何字段都不能作为 API 响应或日志中的凭据材料。
 */
export const users = mysqlTable(
  "users",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    /** 用户输入并经 schema 校验的登录名原表示，响应可展示但不承担唯一性。 */
    username: varchar("username", { length: 64 }).notNull(),
    /** Auth Service 规范化的唯一登录键，消费方不得用 displayName 替代。 */
    normalizedUsername: varchar("normalized_username", {
      length: 64,
    }).notNull(),
    /** 可变展示名，不是租户边界或资源所有权证据。 */
    displayName: varchar("display_name", { length: 160 }).notNull(),
    /** 密码派生算法版本，与 salt/hash 组合决定验证方式。 */
    passwordScheme: varchar("password_scheme", { length: 32 }).notNull(),
    /** 每用户随机 salt 的编码；不是密码，也不得单独用于认证。 */
    passwordSalt: varchar("password_salt", { length: 64 }).notNull(),
    /** 密码派生结果；Controller/ViewModel 永远不得读取或回显。 */
    passwordHash: varchar("password_hash", { length: 128 }).notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("users_normalized_username_uq").on(table.normalizedUsername),
  ],
);

/**
 * 每用户、每固定模型角色唯一的认证加密配置表。
 *
 * 生产方是 ModelConfiguration Service 的加密流程，消费方只能在校验稳定 userId 所有权后解密；
 * endpoint/model 可进入脱敏配置 ViewModel，credentialCiphertext/Nonce/Tag/KeyVersion 永不返回。
 * 四个凭据字段与 version 必须原子轮换，AAD 绑定 userId、role 和 key version，认证失败不得降级。
 */
export const userModelConfigurations = mysqlTable(
  "user_model_configurations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** 服务端固定角色；用户不能创建任意模型代理角色。 */
    role: varchar("role", { length: 32 }).notNull(),
    /** 已通过 HTTPS `/v1` 安全 URL schema 的端点，不含凭据或查询参数。 */
    endpoint: varchar("endpoint", { length: 500 }).notNull(),
    model: varchar("model", { length: 120 }).notNull(),
    /** AES-256-GCM 密文；不包含主密钥，且不得进入 API、日志、事件或测试快照。 */
    credentialCiphertext: text("credential_ciphertext").notNull(),
    /** 当前密文的唯一 nonce，与 tag/keyVersion 必须来自同一次加密。 */
    credentialNonce: varchar("credential_nonce", { length: 32 }).notNull(),
    /** GCM 认证标签；校验失败时配置读取必须 fail-closed。 */
    credentialTag: varchar("credential_tag", { length: 32 }).notNull(),
    /** 环境/KMS 主密钥版本标签，用于选择解密材料和 AAD，主密钥本身不入库。 */
    credentialKeyVersion: varchar("credential_key_version", {
      length: 32,
    }).notNull(),
    /** 用户每次更新/轮换递增的配置版本，模型调用审计绑定该快照。 */
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
