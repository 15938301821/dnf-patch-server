/**
 * @fileoverview 验证声明式 Job Guardrail 拒绝任意执行与本机路径字段；不创建 Run、Job、数据库决策、
 * Worker 或外部进程。
 * @module modules/guardrail/service.spec
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接实例化无依赖的 GuardrailService；没有 Controller、Repository 或数据库 Mock。
 * 输入输出：fixture 模拟已解析的 payload，断言决策为 allow/deny；不证明 Factory 持久化、Run 事务或
 * 真实 Worker 的 capability 注册。
 * 副作用：没有网络、数据库、对象存储或本机文件副作用。
 * 安全边界：测试覆盖 Unicode/命名变体能够表达的 executable、script、game path 等输入，防止未来
 * 修改把声明式任务退化为任意命令入口。
 */
import { describe, expect, it } from "vitest";
import type { GuardrailInput } from "./guardrail.contracts.js";
import { GuardrailService } from "./guardrail.service.js";

/** 该 Service 是纯内存决策器，直接实例化不会绕过任何需要真实 Nest/数据库验证的边界。 */
const service = new GuardrailService();

/**
 * 使用固定策略包装待测 payload。
 * @param payload 仅替换声明式参数；其余字段保持最小合法 fixture，避免测试无关 Factory/HTTP 逻辑。
 * @returns Guardrail 的 allow/deny 决策字符串。
 */
function evaluate(payload: GuardrailInput["payload"]): string {
  return service.evaluate({
    policyId: "policy-v2",
    policySha256: "a".repeat(64),
    jobKind: "shared-fx",
    payload,
    deploymentAuthorized: false,
  }).decision;
}

describe("guardrail payload policy", () => {
  it("allows declarative relative metadata", () => {
    expect(
      evaluate({
        profileId: "fixed-profile",
        inputs: ["manifest"],
      }),
    ).toBe("allow");
  });

  it("allows style production payload without executable or path fields", () => {
    expect(
      evaluate({
        schemaVersion: 1,
        profileId: "profile-v2",
        parameters: {
          workflow: "style-skill-production-v1",
          professionId: "11111111-1111-4111-8111-111111111111",
          styleId: "22222222-2222-4222-8222-222222222222",
          selectedSkillIds: ["33333333-3333-4333-8333-333333333333"],
          stylePromptSha256: "A".repeat(64),
          skills: [
            {
              skillId: "33333333-3333-4333-8333-333333333333",
              sourceRunId: "44444444-4444-4444-8444-444444444444",
              sourceFrameManifestArtifactId:
                "55555555-5555-4555-8555-555555555555",
              sourceMetadataSha256: "B".repeat(64),
            },
          ],
          toolProfiles: ["aseprite-cli"],
          deploymentAuthorized: false,
        },
      }),
    ).toBe("allow");
  });

  it.each([
    { adapter: { executable: "unexpected.exe" } },
    { adapter: { script_path: "C:\\temp\\run.ps1" } },
    { adapter: { "game-directory": "\\\\server\\share" } },
    { metadata: "file:///etc/passwd" },
  ])("rejects unsafe declarative payload %j", (payload) => {
    expect(evaluate(payload)).toBe("deny");
  });
});
