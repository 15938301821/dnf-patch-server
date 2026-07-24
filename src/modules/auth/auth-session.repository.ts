/**
 * @fileoverview 持久化、轮换和撤销浏览器会话；不签发 Token、不处理 HTTP Cookie，也不保存 Token 原文。
 * @module auth
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 真实登出会话撤销漏洞修复
 *
 * 调用关系：AuthService 在登录、刷新、认证和登出时调用；下游通过 DatabaseService 操作
 * browser_sessions 与 users。输入只含 UUID、Refresh Token SHA-256 和服务端期限，输出为布尔状态。
 * 副作用：新登录在 transaction 中锁定用户并替换旧会话；刷新锁定会话并一次性轮换哈希；撤销写时间。
 * 安全边界：row lock（事务行锁）防止同一 Refresh Token 并发重放；数据库时间决定活动状态，缺行、
 * 哈希不匹配、过期或已撤销均 fail-closed，任何方法都不得记录或返回 Token/哈希。
 */
import { Injectable } from "@nestjs/common";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { browserSessions } from "../../common/db/browser-session-schema.js";
import { DatabaseService } from "../../common/db/database.service.js";
import { users } from "../../common/db/schema.js";

/** 新登录写入的服务端会话数据；Refresh Token 在进入 Repository 前已单向哈希。 */
export interface CreateAuthSessionInput {
  sessionId: string;
  userId: string;
  refreshTokenSha256: string;
  expiresAt: Date;
}

/** 刷新请求的原子旧哈希匹配与新哈希替换数据。 */
export interface RotateAuthSessionInput extends CreateAuthSessionInput {
  currentRefreshTokenSha256: string;
}

/** Auth 领域会话持久化边界；不向 Controller 或其他领域导出数据库行。 */
@Injectable()
export class AuthSessionRepository {
  /** @param connection 全局数据库入口，仅用于本模块固定查询和 transaction。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 为用户建立唯一当前会话，新登录会撤销其旧浏览器会话。
   * @param input AuthService 生成的 UUID、哈希和七天期限。
   * @returns transaction 提交后完成；用户不存在时由限制性外键或锁检查拒绝。
   */
  async replace(input: CreateAuthSessionInput): Promise<void> {
    await this.connection.database.transaction(async (transaction) => {
      // 第一步：锁定用户，串行化同一用户的并发登录，避免两个“当前会话”互相覆盖。
      const [user] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("update");
      if (!user) throw new Error("AUTH_SESSION_USER_NOT_FOUND");
      // 第二步：删除旧会话再插入新会话，两步必须同事务提交，失败时旧会话仍保持原状。
      await transaction
        .delete(browserSessions)
        .where(eq(browserSessions.userId, input.userId));
      const now = new Date();
      await transaction.insert(browserSessions).values({
        id: input.sessionId,
        userId: input.userId,
        refreshTokenSha256: input.refreshTokenSha256,
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  /**
   * 一次性消费当前 Refresh Token，并在同一行锁 transaction 中写入下一枚 Token 哈希。
   * @param input 已验签 Token 的 session/user、旧哈希及新签发哈希和期限。
   * @returns 当前会话活动且旧哈希精确匹配时为 true；重放、过期或撤销时为 false。
   */
  async rotate(input: RotateAuthSessionInput): Promise<boolean> {
    return this.connection.database.transaction(async (transaction) => {
      const [session] = await transaction
        .select({ id: browserSessions.id })
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.id, input.sessionId),
            eq(browserSessions.userId, input.userId),
            eq(
              browserSessions.refreshTokenSha256,
              input.currentRefreshTokenSha256,
            ),
            isNull(browserSessions.revokedAt),
            gt(browserSessions.expiresAt, sql`CURRENT_TIMESTAMP(3)`),
          ),
        )
        .limit(1)
        .for("update");
      if (!session) return false;
      await transaction
        .update(browserSessions)
        .set({
          refreshTokenSha256: input.refreshTokenSha256,
          expiresAt: input.expiresAt,
          updatedAt: sql`CURRENT_TIMESTAMP(3)`,
        })
        .where(eq(browserSessions.id, session.id));
      return true;
    });
  }

  /**
   * 查询 Access Token 所属会话是否仍活动。
   * @param sessionId 已验签 Access Token 中的会话 UUID。
   * @param userId 同一 Token 中的稳定用户 UUID，防止跨用户会话引用。
   * @returns 未撤销且按数据库时间未过期时为 true；不延长会话期限。
   */
  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const [session] = await this.connection.database
      .select({ id: browserSessions.id })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.id, sessionId),
          eq(browserSessions.userId, userId),
          isNull(browserSessions.revokedAt),
          gt(browserSessions.expiresAt, sql`CURRENT_TIMESTAMP(3)`),
        ),
      )
      .limit(1);
    return session !== undefined;
  }

  /**
   * 撤销当前 Access Token 对应的服务端会话，使其 Access/Refresh Token 同时失效。
   * @returns 首次成功撤销为 true；缺失或已撤销时为 false，调用方必须视为认证失败。
   */
  async revoke(sessionId: string, userId: string): Promise<boolean> {
    const result = await this.connection.database
      .update(browserSessions)
      .set({
        revokedAt: sql`CURRENT_TIMESTAMP(3)`,
        updatedAt: sql`CURRENT_TIMESTAMP(3)`,
      })
      .where(
        and(
          eq(browserSessions.id, sessionId),
          eq(browserSessions.userId, userId),
          isNull(browserSessions.revokedAt),
        ),
      );
    return result[0].affectedRows === 1;
  }
}
