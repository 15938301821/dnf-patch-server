/**
 * @fileoverview 提供 OpenAiProvider 单元测试共用的 PNG、固定配置与 fetch 请求读取器；
 * 不访问真实模型端点，也不替代 Provider 对外部响应的运行时校验。
 * @module tests/modules/openai
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - V6 图片 Provider 回归测试整理
 *
 * 调用关系：openai.provider.spec.ts 用这些 fixture 构造外部 HTTP 假响应并读取出站请求。
 * 输入输出：仅处理测试内的 Request、Response、FormData 和固定 PNG；不持久化模型调用或 Artifact。
 * 副作用：stubFetch 会替换当前测试进程的全局 fetch，由调用 spec 的 afterEach 负责恢复。
 * 安全边界：配置只含显式测试密钥和虚构域名，不能证明真实 Provider、计费、图片质量或网络可达性。
 */
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../../../src/config/environment.js";
import {
  OpenAiProvider,
  type OpenAiCallConfiguration,
} from "../../../../src/modules/openai/openai.provider.js";
import { vi } from "vitest";

/** 仅用于 Provider 单元测试的虚构模型配置，不得作为真实凭据或端点。 */
export const configuration: OpenAiCallConfiguration = {
  apiKey: "test-api-key",
  baseUrl: "https://models.example.com/v1",
};

/** 满足签名分支的最小测试 PNG 字节；它不代表可解码的生产图片。 */
export const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

/** 与最小测试 PNG 对应的 Provider JSON 编码。 */
export const pngBase64 = pngBytes.toString("base64");

/** 创建使用固定超时和零重试的 Provider，被测网络边界仍由 fetch stub 接管。 */
export function provider(): OpenAiProvider {
  return new OpenAiProvider(
    new ConfigService<Environment, true>({
      OPENAI_REQUEST_TIMEOUT_MS: 1_000,
      OPENAI_REQUEST_MAX_RETRIES: 0,
    }),
  );
}

/** 按调用顺序返回给定响应，并暴露 mock 供测试复核路由与请求体。 */
export function stubFetch(
  ...responses: Response[]
): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** 将未知测试载荷编码为带 JSON 媒体类型的假 HTTP 响应。 */
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 构造 Provider 路由测试使用的固定 PNG 输入；Service 摘要复核不属于本 fixture 的证明范围。 */
export function imageInput(role: "official-source" | "generated-reference"): {
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

/** 从 fetch 的 string、URL 或 Request 参数读取统一 URL。 */
export function requestUrl(
  input: Parameters<typeof fetch>[0] | undefined,
): string {
  if (!input) throw new Error("FETCH_REQUEST_MISSING");
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** 解析字符串形式的 fetch JSON 请求体；其他正文类型失败关闭。 */
export function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("FETCH_REQUEST_BODY_MISSING");
  }
  const value: unknown = JSON.parse(init.body);
  return value;
}

/** 在 fetch mock 中查找包含固定路由片段的调用，不猜测调用序号。 */
export function findFetchCall(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  urlPart: string,
): Parameters<typeof fetch> | undefined {
  return fetchMock.mock.calls.find((call) =>
    requestUrl(call[0]).includes(urlPart),
  );
}

/** 将 edit 路由的 FormData 读取为媒体类型与原始字节，供测试复核源图未丢失。 */
export async function requestMultipart(
  input: Parameters<typeof fetch>[0] | undefined,
  init: RequestInit | undefined,
): Promise<{ contentType: string; bytes: Buffer }> {
  const request =
    input instanceof Request
      ? input.clone()
      : init?.body instanceof FormData
        ? new Request("https://multipart.test", {
            method: "POST",
            body: init.body,
          })
        : undefined;
  if (request) {
    return {
      contentType: request.headers.get("content-type") ?? "",
      bytes: Buffer.from(await request.arrayBuffer()),
    };
  }
  throw new Error("FETCH_MULTIPART_BODY_MISSING");
}

/** 读取 Request 或字符串正文中的未知 JSON，断言前仍由测试做结构匹配。 */
export async function requestJson(
  input: Parameters<typeof fetch>[0] | undefined,
  init: RequestInit | undefined,
): Promise<unknown> {
  if (input instanceof Request) return input.clone().json();
  return requestBody(init);
}
