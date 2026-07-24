/**
 * @fileoverview 定义每用户唯一的可撤销浏览器会话；只保存 Refresh Token 的 SHA-256，不保存 Token 原文。
 * @module common/db/browser-session-schema
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 真实登出会话撤销漏洞修复
 *
 * 调用关系：AuthSessionRepository 原子替换、轮换和撤销会话，ApiAuthGuard 经 AuthService 查询活动状态；
 * DatabaseService 与 drizzle-kit 合并本表。输入是服务端生成的 sessionId、userId、哈希和期限。
 * 副作用由 Repository transaction 执行；本定义不签发 Token、不处理 Cookie，也不返回 API ViewModel。
 * 安全边界：每用户最多一个当前会话；数据库不得保存 Access/Refresh Token 原文，用户删除和会话删除
 * 均采用显式生命周期，不能用级联删除掩盖认证状态变化。
 */
import {
  datetime,
  index,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./identity-schema.js";

/** 服务端浏览器会话注册表；Refresh 哈希只用于恒等匹配，不能还原原始 Token。 */
export const browserSessions = mysqlTable(
  "browser_sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    refreshTokenSha256: varchar("refresh_token_sha256", {
      length: 64,
    }).notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    revokedAt: datetime("revoked_at", { mode: "date", fsp: 3 }),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("browser_sessions_user_uq").on(table.userId),
    uniqueIndex("browser_sessions_refresh_sha256_uq").on(
      table.refreshTokenSha256,
    ),
    index("browser_sessions_active_idx").on(table.revokedAt, table.expiresAt),
  ],
);
