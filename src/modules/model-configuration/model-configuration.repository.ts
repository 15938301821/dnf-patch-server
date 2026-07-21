/**
 * @fileoverview 持久化每用户固定角色模型元数据和认证加密凭据；不处理明文 Key 或 HTTP。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应前端每用户模型配置）
 */
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import { userModelConfigurations, users } from "../../common/db/schema.js";
import type { EncryptedModelCredential } from "./model-credential-cipher.js";
import type { ModelRole } from "./model-configuration.contracts.js";

export interface ModelConfigurationRecord {
  userId: string;
  role: ModelRole;
  endpoint: string;
  model: string;
  credential: EncryptedModelCredential;
  version: number;
}

export interface ModelConfigurationWrite {
  role: ModelRole;
  endpoint: string;
  model: string;
  credential?: EncryptedModelCredential;
}

@Injectable()
export class ModelConfigurationRepository {
  constructor(private readonly connection: DatabaseService) {}

  async listByUser(userId: string): Promise<ModelConfigurationRecord[]> {
    const rows = await this.connection.database
      .select()
      .from(userModelConfigurations)
      .where(eq(userModelConfigurations.userId, userId));
    return rows.map(toRecord);
  }

  async findByUserAndRole(
    userId: string,
    role: ModelRole,
  ): Promise<ModelConfigurationRecord | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(userModelConfigurations)
      .where(
        and(
          eq(userModelConfigurations.userId, userId),
          eq(userModelConfigurations.role, role),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : undefined;
  }

  /** 锁定用户及其角色配置，保证首次 Key 要求和保留已有 Key 的更新原子化。 */
  async saveAll(
    userId: string,
    writes: ModelConfigurationWrite[],
  ): Promise<ModelConfigurationRecord[] | undefined> {
    return this.connection.database.transaction(async (transaction) => {
      const [user] = await transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      if (!user) return undefined;
      const existing = await transaction
        .select()
        .from(userModelConfigurations)
        .where(eq(userModelConfigurations.userId, userId))
        .for("update");
      const existingByRole = new Map(existing.map((row) => [row.role, row]));
      if (
        writes.some(
          (write) => !write.credential && !existingByRole.has(write.role),
        )
      ) {
        return undefined;
      }
      const now = new Date();
      for (const write of writes) {
        const current = existingByRole.get(write.role);
        if (current) {
          await transaction
            .update(userModelConfigurations)
            .set({
              endpoint: write.endpoint,
              model: write.model,
              version: current.version + 1,
              updatedAt: now,
              ...(write.credential ? credentialColumns(write.credential) : {}),
            })
            .where(eq(userModelConfigurations.id, current.id));
          continue;
        }
        const credential = write.credential;
        if (!credential) throw new Error("MODEL_CREDENTIAL_REQUIRED");
        await transaction.insert(userModelConfigurations).values({
          id: randomUUID(),
          userId,
          role: write.role,
          endpoint: write.endpoint,
          model: write.model,
          ...credentialColumns(credential),
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      const saved = await transaction
        .select()
        .from(userModelConfigurations)
        .where(eq(userModelConfigurations.userId, userId));
      return saved.map(toRecord);
    });
  }
}

function credentialColumns(credential: EncryptedModelCredential): {
  credentialCiphertext: string;
  credentialNonce: string;
  credentialTag: string;
  credentialKeyVersion: string;
} {
  return {
    credentialCiphertext: credential.ciphertext,
    credentialNonce: credential.nonce,
    credentialTag: credential.tag,
    credentialKeyVersion: credential.keyVersion,
  };
}

function toRecord(
  row: typeof userModelConfigurations.$inferSelect,
): ModelConfigurationRecord {
  const role = row.role as ModelRole;
  return {
    userId: row.userId,
    role,
    endpoint: row.endpoint,
    model: row.model,
    credential: {
      ciphertext: row.credentialCiphertext,
      nonce: row.credentialNonce,
      tag: row.credentialTag,
      keyVersion: row.credentialKeyVersion,
    },
    version: row.version,
  };
}
