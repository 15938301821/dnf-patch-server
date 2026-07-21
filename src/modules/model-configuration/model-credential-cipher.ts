/**
 * @fileoverview 使用环境主密钥对用户模型凭据执行 AES-256-GCM 认证加密；不持久化主密钥或明文。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应前端每用户模型 Key 配置）
 */
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Environment } from "../../config/environment.js";
import type { ModelRole } from "./model-configuration.contracts.js";

export interface EncryptedModelCredential {
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: string;
}

@Injectable()
export class ModelCredentialCipher {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  /** 加密单个用户角色的 Key，并将归属信息绑定为认证附加数据。 */
  encrypt(
    userId: string,
    role: ModelRole,
    apiKey: string,
  ): EncryptedModelCredential {
    const keyVersion = this.config.getOrThrow("MODEL_CREDENTIAL_KEY_VERSION", {
      infer: true,
    });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey(), nonce);
    cipher.setAAD(aad(userId, role, keyVersion));
    const ciphertext = Buffer.concat([
      cipher.update(apiKey, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64url"),
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      keyVersion,
    };
  }

  /** 解密前校验用户、角色和密钥版本；任何篡改均由 GCM 验证拒绝。 */
  decrypt(
    userId: string,
    role: ModelRole,
    credential: EncryptedModelCredential,
  ): string {
    const currentVersion = this.config.getOrThrow(
      "MODEL_CREDENTIAL_KEY_VERSION",
      { infer: true },
    );
    if (credential.keyVersion !== currentVersion) {
      throw new Error("MODEL_CREDENTIAL_KEY_VERSION_UNAVAILABLE");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.masterKey(),
      Buffer.from(credential.nonce, "base64url"),
    );
    decipher.setAAD(aad(userId, role, credential.keyVersion));
    decipher.setAuthTag(Buffer.from(credential.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(credential.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private masterKey(): Buffer {
    const encoded = this.config.get("MODEL_CREDENTIAL_MASTER_KEY", {
      infer: true,
    });
    if (!encoded) throw new Error("MODEL_CREDENTIAL_MASTER_KEY_NOT_CONFIGURED");
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32)
      throw new Error("MODEL_CREDENTIAL_MASTER_KEY_INVALID");
    return key;
  }
}

function aad(userId: string, role: ModelRole, keyVersion: string): Buffer {
  return Buffer.from(
    JSON.stringify({ schemaVersion: 1, userId, role, keyVersion }),
    "utf8",
  );
}
