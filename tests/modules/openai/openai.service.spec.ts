/**
 * @fileoverview 验证 ModelCall 的授权、running、实际 egress 与终态审计，不访问模型网络。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelCallView,
  StructuredModelRequest,
} from "../../../src/modules/openai/openai.contracts.js";
import type { OpenAiProviderPort } from "../../../src/modules/openai/openai.provider.js";
import { OpenAiService } from "../../../src/modules/openai/openai.service.js";

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
    image: vi.fn<OpenAiProviderPort["image"]>(),
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
        reasoningEffort: role === "spriteProcessor" ? "high" : "default",
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
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
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
      expect.objectContaining({
        model: "spriteProcessor-model",
        reasoningEffort: "high",
      }),
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
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(result.record.providerLatencyMs).toBeGreaterThan(0);
    expect(calls.finish).toHaveBeenCalledWith(
      pending?.id,
      expect.objectContaining({
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      }),
      expect.any(Date),
    );
    const structuredFinish = calls.finish.mock.calls[0]?.[1] as
      | ModelCallView
      | undefined;
    expect(structuredFinish?.providerLatencyMs).toBeGreaterThan(0);
    expect(result.value).toEqual({ accepted: true });
  });

  it("在结构化出站前执行领域门禁，拒绝时零 Provider 调用", async () => {
    const beforeEgress = vi.fn().mockResolvedValue("rejected");

    const result = await service.structured(structuredRequest(), beforeEgress);

    const pending = calls.create.mock.calls[0]?.[0] as
      | ModelCallView
      | undefined;
    expect(beforeEgress).toHaveBeenCalledWith(pending);
    expect(result.value).toBeUndefined();
    expect(result.record).toMatchObject({
      id: pending?.id,
      status: "failed",
      modelEgressPerformed: false,
      errorCode: "MODEL_EGRESS_GUARD_REJECTED",
    });
    expect(calls.markEgressPerformed).not.toHaveBeenCalled();
    expect(provider.structured).not.toHaveBeenCalled();
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
    expect(result.record.providerLatencyMs).toBeGreaterThan(0);
  });

  it("在图片出站前持久化执行绑定，门禁拒绝时零 Provider 调用", async () => {
    const beforeEgress = vi.fn().mockResolvedValue("rejected");

    const result = await service.image(
      {
        runId: crypto.randomUUID(),
        role: "artist",
        prompt: "bounded prompt",
      },
      beforeEgress,
    );

    const pending = calls.create.mock.calls[0]?.[0] as
      | ModelCallView
      | undefined;
    expect(beforeEgress).toHaveBeenCalledWith(pending);
    expect(result.record).toMatchObject({
      id: pending?.id,
      status: "failed",
      modelEgressPerformed: false,
      errorCode: "MODEL_EGRESS_GUARD_REJECTED",
    });
    expect(calls.markEgressPerformed).not.toHaveBeenCalled();
    expect(provider.image).not.toHaveBeenCalled();
  });

  it("只有图片出站门禁接受后才标记 performed 并调用 Provider", async () => {
    const beforeEgress = vi.fn().mockResolvedValue("accepted");
    provider.image.mockResolvedValue({
      bytes: Buffer.from("png"),
      usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
    });

    const result = await service.image(
      {
        runId: crypto.randomUUID(),
        role: "artist",
        prompt: "bounded prompt",
      },
      beforeEgress,
    );

    expect(beforeEgress).toHaveBeenCalledOnce();
    expect(calls.markEgressPerformed).toHaveBeenCalledOnce();
    expect(provider.image).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      bytes: Buffer.from("png"),
      record: {
        status: "passed",
        modelEgressPerformed: true,
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
      },
    });
    expect(result.record.providerLatencyMs).toBeGreaterThan(0);
  });

  it("rejects a drifted source image before audit creation or provider egress", async () => {
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("source"),
    ]);

    await expect(
      service.image({
        runId: crypto.randomUUID(),
        role: "artist",
        prompt: "bounded prompt",
        sourceImage: {
          role: "official-source",
          mediaType: "image/png",
          bytes,
          sha256: "F".repeat(64),
        },
      }),
    ).rejects.toThrow("MODEL_IMAGE_INPUT_INVALID");
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.markEgressPerformed).not.toHaveBeenCalled();
    expect(provider.image).not.toHaveBeenCalled();
  });

  it("passes verified image identities into the request hash and provider", async () => {
    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("source"),
    ]);
    const sha256 = createHash("sha256")
      .update(bytes)
      .digest("hex")
      .toUpperCase();
    provider.image.mockResolvedValue({ bytes: Buffer.from("png") });

    await service.image({
      runId: crypto.randomUUID(),
      role: "artist",
      prompt: "bounded prompt",
      sourceImage: {
        role: "official-source",
        mediaType: "image/png",
        bytes,
        sha256,
      },
    });

    const outbound = firstMockArgument(provider.image.mock.calls);
    if (
      typeof outbound !== "object" ||
      outbound === null ||
      !("sourceImage" in outbound)
    ) {
      throw new Error("TEST_SOURCE_IMAGE_REQUIRED");
    }
    expect(outbound.sourceImage).toMatchObject({ sha256, bytes });
    const pending = firstMockArgument(calls.create.mock.calls);
    if (
      typeof pending !== "object" ||
      pending === null ||
      !("requestSha256" in pending) ||
      typeof pending.requestSha256 !== "string"
    ) {
      throw new Error("TEST_MODEL_CALL_REQUIRED");
    }
    expect(pending.requestSha256).toMatch(/^[A-F0-9]{64}$/u);
  });

  it("为 V6 target 协商画布、哈希策略并按实际 PNG 冻结无拉伸几何", async () => {
    const providerBytes = await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 4,
        background: { r: 20, g: 40, b: 60, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    provider.image.mockResolvedValue({ bytes: providerBytes });

    const first = await service.image({
      runId: crypto.randomUUID(),
      role: "artist",
      prompt: "bounded prompt",
      targetDimensions: { width: 4, height: 3 },
    });
    const second = await service.image({
      runId: crypto.randomUUID(),
      role: "artist",
      prompt: "bounded prompt",
      targetDimensions: { width: 3, height: 4 },
    });

    const firstOutbound = provider.image.mock.calls[0]?.[0];
    const secondOutbound = provider.image.mock.calls[1]?.[0];
    expect(firstOutbound).toMatchObject({
      requestedCanvas: {
        openAiSize: "1536x1024",
        geminiAspectRatio: "3:2",
      },
    });
    expect(firstOutbound?.prompt).toContain("exact aspect ratio is 4:3");
    expect(secondOutbound).toMatchObject({
      requestedCanvas: {
        openAiSize: "1024x1536",
        geminiAspectRatio: "2:3",
      },
    });
    expect(first.targetGeometry).toMatchObject({
      target: { width: 4, height: 3 },
      providerCanvas: { width: 12, height: 8 },
      contentRect: { left: 2, top: 1, width: 8, height: 6 },
      uniformScale: { numerator: 1, denominator: 2 },
    });
    expect(second.targetGeometry).toMatchObject({
      target: { width: 3, height: 4 },
      contentRect: { left: 3, top: 0, width: 6, height: 8 },
    });
    const firstRecord = calls.create.mock.calls[0]?.[0] as ModelCallView;
    const secondRecord = calls.create.mock.calls[1]?.[0] as ModelCallView;
    expect(firstRecord.requestSha256).not.toBe(secondRecord.requestSha256);
  });
});

function firstMockArgument(calls: unknown): unknown {
  if (!Array.isArray(calls) || !Array.isArray(calls[0])) return undefined;
  return calls[0][0] as unknown;
}

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
