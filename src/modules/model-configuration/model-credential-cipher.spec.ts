/**
 * @fileoverview 验证模型凭据认证加密的往返、用户/角色隔离与篡改拒绝。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应前端每用户模型 Key 配置）
 */
import { describe, expect, it } from "vitest";
import { ModelCredentialCipher } from "./model-credential-cipher.js";

const userId = "11111111-1111-4111-8111-111111111111";

describe("ModelCredentialCipher", () => {
  const cipher = new ModelCredentialCipher(configService());

  it("round-trips a Key without exposing plaintext in persisted fields", () => {
    const encrypted = cipher.encrypt(userId, "orchestrator", "private-key");

    expect(JSON.stringify(encrypted)).not.toContain("private-key");
    expect(cipher.decrypt(userId, "orchestrator", encrypted)).toBe(
      "private-key",
    );
  });

  it("rejects cross-user, cross-role, and modified ciphertext", () => {
    const encrypted = cipher.encrypt(userId, "orchestrator", "private-key");

    expect(() =>
      cipher.decrypt(
        "22222222-2222-4222-8222-222222222222",
        "orchestrator",
        encrypted,
      ),
    ).toThrow();
    expect(() =>
      cipher.decrypt(userId, "spriteProcessor", encrypted),
    ).toThrow();
    expect(() =>
      cipher.decrypt(userId, "orchestrator", {
        ...encrypted,
        ciphertext: `${encrypted.ciphertext}A`,
      }),
    ).toThrow();
  });
});

function configService(): ConstructorParameters<
  typeof ModelCredentialCipher
>[0] {
  const values = {
    MODEL_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
    MODEL_CREDENTIAL_KEY_VERSION: "v1",
  };
  return {
    get(key: keyof typeof values) {
      return values[key];
    },
    getOrThrow(key: keyof typeof values) {
      return values[key];
    },
  } as ConstructorParameters<typeof ModelCredentialCipher>[0];
}
