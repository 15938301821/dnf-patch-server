/**
 * @fileoverview 验证每用户三角色模型配置保存、Key 保留和脱敏响应；不连接真实数据库。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import type { EncryptedModelCredential } from "./model-credential-cipher.js";
import type { SaveModelRoleConfigurationInput } from "./model-configuration.contracts.js";
import type {
  ModelConfigurationRecord,
  ModelConfigurationWrite,
} from "./model-configuration.repository.js";
import { ModelConfigurationService } from "./model-configuration.service.js";

describe("ModelConfigurationService", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  let records: ModelConfigurationRecord[];
  let service: ModelConfigurationService;

  beforeEach(() => {
    records = [];
    service = new ModelConfigurationService(
      configService(),
      repository(records),
      cipher(),
    );
  });

  it("returns environment defaults without claiming a configured Key", async () => {
    await expect(service.get(userId)).resolves.toEqual({
      orchestrator: {
        endpoint: "https://models.example.test/v1",
        model: "planner-model",
        keyConfigured: false,
      },
      spriteProcessor: {
        endpoint: "https://models.example.test/v1",
        model: "engineer-model",
        keyConfigured: false,
      },
      referenceGenerator: {
        endpoint: "https://models.example.test/v1",
        model: "image-model",
        keyConfigured: false,
      },
    });
  });

  it("requires every role Key on first save and never returns submitted values", async () => {
    await expect(
      service.save(userId, {
        orchestrator: roleInput("planner-v2", "planner-key"),
        spriteProcessor: roleInput("engineer-v2", "engineer-key"),
        referenceGenerator: roleInput("image-v2"),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const saved = await service.save(userId, {
      orchestrator: roleInput("planner-v2", "planner-key"),
      spriteProcessor: roleInput("engineer-v2", "engineer-key"),
      referenceGenerator: roleInput("image-v2", "image-key"),
    });

    expect(saved).toEqual({
      orchestrator: {
        endpoint: "https://user-models.example/v1",
        model: "planner-v2",
        keyConfigured: true,
      },
      spriteProcessor: {
        endpoint: "https://user-models.example/v1",
        model: "engineer-v2",
        keyConfigured: true,
      },
      referenceGenerator: {
        endpoint: "https://user-models.example/v1",
        model: "image-v2",
        keyConfigured: true,
      },
    });
    expect(JSON.stringify(saved)).not.toContain("planner-key");
  });

  it("keeps the encrypted Key when a later save leaves apiKey empty", async () => {
    await service.save(userId, {
      orchestrator: roleInput("planner-v1", "planner-key"),
      spriteProcessor: roleInput("engineer-v1", "engineer-key"),
      referenceGenerator: roleInput("image-v1", "image-key"),
    });
    const previous = records.find((record) => record.role === "orchestrator");

    await service.save(userId, {
      orchestrator: roleInput("planner-v2"),
      spriteProcessor: roleInput("engineer-v2"),
      referenceGenerator: roleInput("image-v2"),
    });
    const current = records.find((record) => record.role === "orchestrator");

    expect(current?.credential).toEqual(previous?.credential);
    await expect(
      service.resolve(userId, "orchestrator"),
    ).resolves.toMatchObject({
      model: "planner-v2",
      apiKey: "planner-key",
      keyConfigured: true,
    });
  });
});

function configService(): ConstructorParameters<
  typeof ModelConfigurationService
>[0] {
  const values = {
    OPENAI_BASE_URL: "https://models.example.test/v1",
    OPENAI_ORCHESTRATOR_MODEL: "planner-model",
    OPENAI_ENGINEER_MODEL: "engineer-model",
    OPENAI_IMAGE_MODEL: "image-model",
  };
  return {
    getOrThrow(key: keyof typeof values) {
      return values[key];
    },
  } as ConstructorParameters<typeof ModelConfigurationService>[0];
}

function repository(
  records: ModelConfigurationRecord[],
): ConstructorParameters<typeof ModelConfigurationService>[1] {
  return {
    listByUser(requestedUserId: string) {
      return Promise.resolve(
        records.filter((record) => record.userId === requestedUserId),
      );
    },
    findByUserAndRole(requestedUserId: string, role: string) {
      return Promise.resolve(
        records.find(
          (record) => record.userId === requestedUserId && record.role === role,
        ),
      );
    },
    saveAll(requestedUserId: string, writes: ModelConfigurationWrite[]) {
      if (
        writes.some(
          (write) =>
            !write.credential &&
            !records.some(
              (record) =>
                record.userId === requestedUserId && record.role === write.role,
            ),
        )
      ) {
        return Promise.resolve(undefined);
      }
      for (const write of writes) {
        const existing = records.find(
          (record) =>
            record.userId === requestedUserId && record.role === write.role,
        );
        if (existing) {
          existing.endpoint = write.endpoint;
          existing.model = write.model;
          existing.version += 1;
          if (write.credential) existing.credential = write.credential;
          continue;
        }
        if (!write.credential) return Promise.resolve(undefined);
        records.push({
          userId: requestedUserId,
          role: write.role,
          endpoint: write.endpoint,
          model: write.model,
          credential: write.credential,
          version: 1,
        });
      }
      return Promise.resolve(
        records.filter((record) => record.userId === requestedUserId),
      );
    },
  } as ConstructorParameters<typeof ModelConfigurationService>[1];
}

function cipher(): ConstructorParameters<typeof ModelConfigurationService>[2] {
  return {
    encrypt(_userId: string, _role: string, apiKey: string) {
      return credential(apiKey);
    },
    decrypt(
      _userId: string,
      _role: string,
      encrypted: EncryptedModelCredential,
    ) {
      return Buffer.from(encrypted.ciphertext, "base64url").toString("utf8");
    },
  } as ConstructorParameters<typeof ModelConfigurationService>[2];
}

function credential(apiKey: string): EncryptedModelCredential {
  return {
    ciphertext: Buffer.from(apiKey, "utf8").toString("base64url"),
    nonce: "test-nonce",
    tag: "test-tag",
    keyVersion: "v1",
  };
}

function roleInput(
  model: string,
  apiKey?: string,
): SaveModelRoleConfigurationInput {
  return {
    endpoint: "https://user-models.example/v1",
    model,
    ...(apiKey ? { apiKey } : {}),
  };
}
