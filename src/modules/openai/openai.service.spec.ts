/**
 * @fileoverview 验证 ModelCall 的授权、running、实际 egress 与终态审计，不访问模型网络。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelCallView,
  StructuredModelRequest,
} from "./openai.contracts.js";
import { OpenAiService } from "./openai.service.js";

describe("OpenAiService model evidence", () => {
  const ownerUserId = "11111111-1111-4111-8111-111111111111";
  const calls = {
    create: vi.fn(),
    markEgressPerformed: vi.fn(),
    finish: vi.fn(),
    abandonStale: vi.fn(),
  };
  const runs = { getModelContext: vi.fn() };
  const configurations = { resolve: vi.fn() };
  const provider = {
    structured: vi.fn(),
    image: vi.fn(),
  };
  let service: OpenAiService;

  beforeEach(() => {
    vi.resetAllMocks();
    runs.getModelContext.mockResolvedValue({
      modelEgressAuthorized: true,
      ownerUserId,
    });
    configurations.resolve.mockImplementation((_userId: string, role: string) =>
      Promise.resolve({
        endpoint: "https://models.example.com/v1",
        model: `${role}-model`,
        keyConfigured: true,
        apiKey: "test-api-key",
        version: 7,
      }),
    );
    calls.markEgressPerformed.mockResolvedValue(true);
    calls.finish.mockResolvedValue(true);
    service = new OpenAiService(calls, runs, configurations, provider);
  });

  it("未授权时记录 blocked 且不执行 provider", async () => {
    runs.getModelContext.mockResolvedValue({
      modelEgressAuthorized: false,
      ownerUserId,
    });

    const result = await service.structured(structuredRequest());

    expect(result.record).toMatchObject({
      status: "blocked",
      modelEgressAuthorized: false,
      modelEgressPerformed: false,
      errorCode: "MODEL_EGRESS_NOT_AUTHORIZED",
    });
    expect(calls.create).toHaveBeenCalledWith(result.record);
    expect(configurations.resolve).not.toHaveBeenCalled();
    expect(calls.markEgressPerformed).not.toHaveBeenCalled();
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it("已授权但 Run 缺少 owner 时记录 blocked", async () => {
    runs.getModelContext.mockResolvedValue({ modelEgressAuthorized: true });

    const result = await service.structured(structuredRequest());

    expect(result.record).toMatchObject({
      status: "blocked",
      modelEgressAuthorized: true,
      modelEgressPerformed: false,
      errorCode: "MODEL_CONFIGURATION_OWNER_REQUIRED",
    });
    expect(configurations.resolve).not.toHaveBeenCalled();
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it("已授权但个人配置缺失时记录 blocked", async () => {
    configurations.resolve.mockResolvedValue(undefined);

    const result = await service.structured(structuredRequest());

    expect(result.record).toMatchObject({
      status: "blocked",
      modelEgressAuthorized: true,
      modelEgressPerformed: false,
      errorCode: "MODEL_CONFIGURATION_NOT_CONFIGURED",
    });
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it("个人配置解密失败时记录 blocked 且不执行 provider", async () => {
    configurations.resolve.mockRejectedValue(
      new Error("MODEL_CREDENTIAL_DECRYPTION_FAILED"),
    );

    const result = await service.structured(structuredRequest());

    expect(result.record).toMatchObject({
      status: "blocked",
      modelEgressAuthorized: true,
      modelEgressPerformed: false,
      errorCode: "MODEL_CONFIGURATION_UNAVAILABLE",
    });
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it("实际调用前持久化 running 并标记 egress，成功后进入 passed", async () => {
    provider.structured.mockResolvedValue({
      responseId: "response-1",
      value: { accepted: true },
    });

    const result = await service.structured(structuredRequest());

    const pending = calls.create.mock.calls[0]?.[0] as
      | ModelCallView
      | undefined;
    expect(pending).toMatchObject({
      status: "running",
      model: "spriteProcessor-model",
      endpointIdentity: "models.example.com/v1",
      modelConfigurationVersion: 7,
      modelEgressAuthorized: true,
      modelEgressPerformed: false,
    });
    expect(configurations.resolve).toHaveBeenCalledWith(
      ownerUserId,
      "spriteProcessor",
    );
    expect(provider.structured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "spriteProcessor-model" }),
      {
        apiKey: "test-api-key",
        baseUrl: "https://models.example.com/v1",
      },
    );
    expect(calls.markEgressPerformed).toHaveBeenCalledWith(pending?.id);
    expect(result.record).toMatchObject({
      status: "passed",
      modelEgressPerformed: true,
      responseId: "response-1",
    });
    expect(result.value).toEqual({ accepted: true });
  });

  it("provider 失败时保留 performed 事实并进入 failed", async () => {
    provider.image.mockRejectedValue(new Error("provider unavailable"));

    const result = await service.image({
      runId: crypto.randomUUID(),
      role: "artist",
      prompt: "bounded prompt",
    });

    expect(result.bytes).toBeUndefined();
    expect(result.record).toMatchObject({
      status: "failed",
      modelEgressAuthorized: true,
      modelEgressPerformed: true,
      errorCode: "MODEL_PROVIDER_REQUEST_FAILED",
    });
  });
});

function structuredRequest(): StructuredModelRequest<{
  accepted: boolean;
}> {
  return {
    runId: crypto.randomUUID(),
    role: "engineer" as const,
    schemaName: "model_evidence_test",
    schema: z.object({ accepted: z.boolean() }).strict(),
    instructions: "Return a bounded structured response.",
    input: "verified input hash context",
  };
}
