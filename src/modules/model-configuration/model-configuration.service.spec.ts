/**
 * @fileoverview 验证模型配置只暴露环境托管状态，并拒绝浏览器保存 API Key。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import { ConflictException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ModelConfigurationService } from "./model-configuration.service.js";

describe("ModelConfigurationService", () => {
  it("returns role models and redacted key state from environment", () => {
    const service = new ModelConfigurationService(configService("present-key"));
    expect(service.get()).toEqual({
      orchestrator: {
        endpoint: "https://models.example.test/v1",
        model: "planner-model",
        keyConfigured: true,
        keyPreview: "configured",
      },
      spriteProcessor: {
        endpoint: "https://models.example.test/v1",
        model: "engineer-model",
        keyConfigured: true,
        keyPreview: "configured",
      },
      referenceGenerator: {
        endpoint: "https://models.example.test/v1",
        model: "image-model",
        keyConfigured: true,
        keyPreview: "configured",
      },
    });
  });

  it("rejects browser-submitted API keys", () => {
    const service = new ModelConfigurationService(configService(undefined));
    expect(() =>
      service.save({
        orchestrator: {
          endpoint: "https://models.example.test/v1",
          model: "planner-model",
          apiKey: "secret",
        },
        spriteProcessor: {
          endpoint: "https://models.example.test/v1",
          model: "engineer-model",
        },
        referenceGenerator: {
          endpoint: "https://models.example.test/v1",
          model: "image-model",
        },
      }),
    ).toThrow(ConflictException);
  });
});

function configService(
  apiKey: string | undefined,
): ConstructorParameters<typeof ModelConfigurationService>[0] {
  const values = {
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: "https://models.example.test/v1",
    OPENAI_ORCHESTRATOR_MODEL: "planner-model",
    OPENAI_ENGINEER_MODEL: "engineer-model",
    OPENAI_IMAGE_MODEL: "image-model",
  };
  return {
    get(key: keyof typeof values) {
      return values[key];
    },
    getOrThrow(key: keyof typeof values) {
      const value = values[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    },
  } as ConstructorParameters<typeof ModelConfigurationService>[0];
}
