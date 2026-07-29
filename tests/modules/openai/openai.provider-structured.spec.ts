/** @fileoverview 验证 OpenAI Responses 推理强度与双图结构化输入协议；不访问真实模型网络。 */
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Environment } from "../../../src/config/environment.js";
import {
  OpenAiProvider,
  type StructuredProviderRequest,
} from "../../../src/modules/openai/openai.provider.js";

const configuration = {
  apiKey: "test-api-key",
  baseUrl: "https://models.example.com/v1",
};
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const pngBase64 = pngBytes.toString("base64");

describe("OpenAiProvider structured protocol", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends explicit reasoning effort through the Responses request body", async () => {
    const fetchMock = stubFetch();
    await expect(
      provider().structured(structuredRequest("max"), configuration),
    ).resolves.toMatchObject({
      responseId: "response-1",
      value: { accepted: true },
    });
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://models.example.com/v1/responses",
    );
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      model: "test-model",
      reasoning: { effort: "max" },
      store: false,
    });
  });

  it("omits reasoning from the Responses request body for default", async () => {
    const fetchMock = stubFetch();
    await provider().structured(structuredRequest("default"), configuration);
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).not.toHaveProperty(
      "reasoning",
    );
  });

  it("sends official source and generated reference as bounded Responses images", async () => {
    const fetchMock = stubFetch();
    const request = structuredRequest("max");
    request.imageInputs = [
      imageInput("official-source"),
      imageInput("generated-reference"),
    ];
    await provider().structured(request, configuration);
    const body = requestBody(fetchMock.mock.calls[0]?.[1]);
    if (typeof body !== "object" || body === null || !("input" in body)) {
      throw new Error("RESPONSES_INPUT_MISSING");
    }
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "bounded input" },
          {
            type: "input_image",
            detail: "original",
            image_url: `data:image/png;base64,${pngBase64}`,
          },
          {
            type: "input_image",
            detail: "original",
            image_url: `data:image/png;base64,${pngBase64}`,
          },
        ],
      },
    ]);
  });
});

function provider(): OpenAiProvider {
  return new OpenAiProvider(
    new ConfigService<Environment, true>({
      OPENAI_REQUEST_TIMEOUT_MS: 1_000,
      OPENAI_REQUEST_MAX_RETRIES: 0,
    }),
  );
}

function stubFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "response-1",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: JSON.stringify({ accepted: true }) },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function structuredRequest(
  reasoningEffort: "default" | "max",
): StructuredProviderRequest<{ accepted: boolean }> {
  return {
    model: "test-model",
    reasoningEffort,
    schemaName: "test_response",
    schema: z.object({ accepted: z.boolean() }),
    instructions: "Return the bounded schema.",
    input: "bounded input",
  };
}

function imageInput(role: "official-source" | "generated-reference"): {
  role: "official-source" | "generated-reference";
  mediaType: "image/png";
  bytes: Buffer;
  sha256: string;
} {
  return {
    role,
    mediaType: "image/png" as const,
    bytes: pngBytes,
    sha256: "A".repeat(64),
  };
}

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  if (!input) throw new Error("FETCH_REQUEST_MISSING");
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string")
    throw new Error("FETCH_REQUEST_BODY_MISSING");
  return JSON.parse(init.body) as unknown;
}
