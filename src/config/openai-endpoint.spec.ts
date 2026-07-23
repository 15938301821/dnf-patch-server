/**
 * @fileoverview 验证模型端点规范化与脱敏拒绝规则；不连接外部 Provider，也不证明模型 ID、TLS
 * 证书、认证或响应格式可用。
 * @module config/openai-endpoint/tests
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接调用纯函数。输入均为文档保留域或故意不安全 URL，输出为结构或 Error；
 * 无网络、凭据或 Mock 副作用。安全边界：凭据与查询参数必须在任何审计或模型调用前被拒绝。
 */
import { describe, expect, it } from "vitest";
import { resolveOpenAiEndpoint } from "./openai-endpoint.js";

describe("resolveOpenAiEndpoint", () => {
  // 审计 identity 必须可区分端点，同时不能携带协议外的敏感 URL 成分。
  it("returns a redacted compatible identity", () => {
    expect(resolveOpenAiEndpoint("https://gateway.example/v1/")).toEqual({
      baseUrl: "https://gateway.example/v1",
      identity: "gateway.example/v1",
      custom: true,
    });
  });

  // 明文传输、URL 凭据、错误 API 路径与查询秘密均应 fail-closed。
  it.each([
    "http://gateway.example/v1",
    "https://user:secret@gateway.example/v1",
    "https://gateway.example/api",
    "https://gateway.example/v1?token=secret",
  ])("rejects unsafe endpoint %s", (value) => {
    expect(() => resolveOpenAiEndpoint(value)).toThrow();
  });
});
