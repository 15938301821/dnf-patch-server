/**
 * @fileoverview 验证固定图片 Provider 的协议选择、外部响应校验与失败关闭；不访问真实模型网络。
 * @module openai
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - 真实生产链查漏补缺
 *
 * 调用关系：测试直接调用 OpenAiProvider，并用 fetch stub 替代 OpenAI/Gemini 外部 HTTP 边界。
 * 输入输出：构造固定角色请求与脱敏假响应，只断言 PNG 字节和协议；不保存 ModelCall 或 Artifact。
 * 副作用：无数据库和对象存储写入；fetch stub 不能证明真实供应商、计费或图片质量。
 * 安全边界：只有 Gemini 图片模型的 404 可进入同源固定 fallback，未知 JSON、非 PNG 和其他错误
 * 必须拒绝，测试数据不得包含真实 API Key。
 */
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../config/environment.js";
import { OpenAiProvider } from "./openai.provider.js";

const configuration = {
  apiKey: "test-api-key",
  baseUrl: "https://models.example.com/v1",
};
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const pngBase64 = pngBytes.toString("base64");

describe("OpenAiProvider image protocol", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("OpenAI Images 成功时返回经过签名校验的 PNG", async () => {
    const fetchMock = stubFetch(
      jsonResponse({
        data: [{ b64_json: pngBase64 }],
        usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
      }),
    );

    const result = await provider().image(
      { model: "gpt-image-1", prompt: "bounded prompt" },
      configuration,
    );

    expect(result).toEqual({
      bytes: pngBytes,
      usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://models.example.com/v1/images/generations",
    );
  });

  it("Gemini 图片模型在 Images 404 后调用同源固定原生协议", async () => {
    const fetchMock = stubFetch(
      jsonResponse(
        { error: { message: "route unavailable", type: "not_found_error" } },
        404,
      ),
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "generated" },
                {
                  inlineData: { mimeType: "image/png", data: pngBase64 },
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 90,
          candidatesTokenCount: 60,
          totalTokenCount: 150,
        },
      }),
    );

    const result = await provider().image(
      {
        model: "gemini-3.1-flash-image-preview",
        prompt: "bounded prompt",
      },
      configuration,
    );

    expect(result).toEqual({
      bytes: pngBytes,
      usage: { inputTokens: 90, outputTokens: 60, totalTokens: 150 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fallbackCall = fetchMock.mock.calls[1];
    expect(requestUrl(fallbackCall?.[0])).toBe(
      "https://models.example.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent",
    );
    expect(requestBody(fallbackCall?.[1])).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "bounded prompt" }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: "3:2", imageSize: "1K" },
      },
    });
  });

  it("Gemini fallback 将有界 JPEG 真实转码为 PNG", async () => {
    const jpeg = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 18, g: 52, b: 86 },
      },
    })
      .jpeg()
      .toBuffer();
    stubFetch(
      jsonResponse(
        { error: { message: "route unavailable", type: "not_found_error" } },
        404,
      ),
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: jpeg.toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await provider().image(
      {
        model: "gemini-3.1-flash-image-preview",
        prompt: "bounded prompt",
      },
      configuration,
    );

    expect(Buffer.from(result.bytes).subarray(0, 8)).toEqual(
      pngBytes.subarray(0, 8),
    );
    await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({
      format: "png",
      width: 3,
      height: 2,
    });
  });

  it("OpenAI Images 的畸形 usage 不影响已验证 PNG 并保持未计量", async () => {
    stubFetch(
      jsonResponse({
        data: [{ b64_json: pngBase64 }],
        usage: { input_tokens: 12, output_tokens: -1, total_tokens: 11 },
      }),
    );

    await expect(
      provider().image(
        { model: "gpt-image-1", prompt: "bounded prompt" },
        configuration,
      ),
    ).resolves.toEqual({ bytes: pngBytes });
  });

  it("Gemini fallback 拒绝声明为 JPEG 的畸形字节", async () => {
    stubFetch(
      jsonResponse(
        { error: { message: "route unavailable", type: "not_found_error" } },
        404,
      ),
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: Buffer.from("not-jpeg").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    await expect(
      provider().image(
        {
          model: "gemini-3.1-flash-image-preview",
          prompt: "bounded prompt",
        },
        configuration,
      ),
    ).rejects.toThrow("IMAGE_PAYLOAD_NOT_JPEG");
  });

  it("Gemini fallback 返回非 PNG 时失败关闭", async () => {
    stubFetch(
      jsonResponse(
        { error: { message: "route unavailable", type: "not_found_error" } },
        404,
      ),
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  inline_data: {
                    mime_type: "image/png",
                    data: Buffer.from("not-png").toString("base64"),
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    await expect(
      provider().image(
        {
          model: "gemini-3.1-flash-image-preview",
          prompt: "bounded prompt",
        },
        configuration,
      ),
    ).rejects.toThrow("IMAGE_PAYLOAD_NOT_PNG");
  });

  it("非 Gemini 模型的 Images 404 不触发 fallback", async () => {
    const fetchMock = stubFetch(
      jsonResponse(
        { error: { message: "route unavailable", type: "not_found_error" } },
        404,
      ),
    );

    await expect(
      provider().image(
        { model: "gpt-image-1", prompt: "bounded prompt" },
        configuration,
      ),
    ).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("Gemini 模型的非 404 错误不触发 fallback", async () => {
    const fetchMock = stubFetch(
      jsonResponse(
        { error: { message: "request rejected", type: "invalid_request" } },
        400,
      ),
    );

    await expect(
      provider().image(
        {
          model: "gemini-3.1-flash-image-preview",
          prompt: "bounded prompt",
        },
        configuration,
      ),
    ).rejects.toBeInstanceOf(OpenAI.BadRequestError);
    expect(fetchMock).toHaveBeenCalledOnce();
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

function stubFetch(
  ...responses: Response[]
): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0] | undefined): string {
  if (!input) throw new Error("FETCH_REQUEST_MISSING");
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("FETCH_REQUEST_BODY_MISSING");
  }
  const value: unknown = JSON.parse(init.body);
  return value;
}
