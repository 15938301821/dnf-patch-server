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
  const config = {
    getOrThrow: vi.fn((key: string) => `${key.toLowerCase()}-id`),
  };
  const calls = {
    create: vi.fn(),
    markEgressPerformed: vi.fn(),
    finish: vi.fn(),
    abandonStale: vi.fn(),
  };
  const runs = { get: vi.fn() };
  const provider = {
    configured: true,
    endpointIdentity: "api.openai.com/v1",
    structured: vi.fn(),
    image: vi.fn(),
  };
  let service: OpenAiService;

  beforeEach(() => {
    vi.resetAllMocks();
    provider.configured = true;
    runs.get.mockResolvedValue({ modelEgressAuthorized: true });
    calls.markEgressPerformed.mockResolvedValue(true);
    calls.finish.mockResolvedValue(true);
    service = new OpenAiService(config, calls, runs, provider);
  });

  it("未授权时记录 blocked 且不执行 provider", async () => {
    runs.get.mockResolvedValue({ modelEgressAuthorized: false });

    const result = await service.structured(structuredRequest());

    expect(result.record).toMatchObject({
      status: "blocked",
      modelEgressAuthorized: false,
      modelEgressPerformed: false,
      errorCode: "MODEL_EGRESS_NOT_AUTHORIZED",
    });
    expect(calls.create).toHaveBeenCalledWith(result.record);
    expect(calls.markEgressPerformed).not.toHaveBeenCalled();
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it("已授权但缺少密钥时记录 blocked 且 performed 为 false", async () => {
    provider.configured = false;

    const result = await service.structured(structuredRequest());

    expect(result.record).toMatchObject({
      status: "blocked",
      modelEgressAuthorized: true,
      modelEgressPerformed: false,
      errorCode: "OPENAI_API_KEY_NOT_CONFIGURED",
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
      modelEgressAuthorized: true,
      modelEgressPerformed: false,
    });
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
