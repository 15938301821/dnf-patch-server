/**
 * @fileoverview 持久化稳定用户身份和密码摘要；不处理 HTTP、会话签名或明文密码。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应前端账号密码登录与用户模型配置归属）
 */
import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { users } from "../../common/db/schema.js";
import type { PasswordDigest } from "./password.js";

export interface AuthUserRecord {
  id: string;
  username: string;
  displayName: string;
  password: PasswordDigest;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly connection: DatabaseService) {}

  async findByNormalizedUsername(
    normalizedUsername: string,
  ): Promise<AuthUserRecord | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(users)
      .where(eq(users.normalizedUsername, normalizedUsername))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async findById(id: string): Promise<AuthUserRecord | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  async create(input: {
    id: string;
    username: string;
    normalizedUsername: string;
    displayName: string;
    password: PasswordDigest;
  }): Promise<AuthUserRecord> {
    const now = new Date();
    await this.connection.database.insert(users).values({
      id: input.id,
      username: input.username,
      normalizedUsername: input.normalizedUsername,
      displayName: input.displayName,
      passwordScheme: input.password.scheme,
      passwordSalt: input.password.salt,
      passwordHash: input.password.hash,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id: input.id,
      username: input.username,
      displayName: input.displayName,
      password: input.password,
    };
  }
}

function toRecord(row: typeof users.$inferSelect): AuthUserRecord {
  if (row.passwordScheme !== "scrypt-v1") {
    throw new Error("USER_PASSWORD_SCHEME_UNSUPPORTED");
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    password: {
      scheme: "scrypt-v1",
      salt: row.passwordSalt,
      hash: row.passwordHash,
    },
  };
}
