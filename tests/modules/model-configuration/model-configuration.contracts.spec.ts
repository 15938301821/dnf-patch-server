/**
 * @fileoverview 验证三固定角色模型配置的推理强度协议边界；不持久化配置或接触凭据。
 *
 * 保存请求先经过本 schema，再进入 Service 加密与数据库写入。文本角色允许六档显式推理强度，
 * 图片角色只能使用内部兼容值 default，避免把 Responses 专用参数错误传入图片 Provider。
 */
import { describe, expect, it } from "vitest";
import {
  saveModelConfigurationSchema,
  type SaveModelConfigurationInput,
  type SaveModelRoleConfigurationInput,
} from "../../../src/modules/model-configuration/model-configuration.contracts.js";

describe("saveModelConfigurationSchema reasoning effort", () => {
  it("accepts explicit reasoning effort for text roles", () => {
    const result = saveModelConfigurationSchema.safeParse(
      configuration("ultra", "xhigh", "default"),
    );

    expect(result.success).toBe(true);
  });

  it("rejects non-default reasoning effort for the image role", () => {
    const result = saveModelConfigurationSchema.safeParse(
      configuration("default", "default", "max"),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error("INVALID_TEST_RESULT");
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["referenceGenerator", "reasoningEffort"],
        }),
      ]),
    );
  });
});

/** 构造不含真实 Key 的完整保存请求，三个参数依次对应调度、精灵处理与参考图角色。 */
function configuration(
  orchestrator: SaveModelRoleConfigurationInput["reasoningEffort"],
  spriteProcessor: SaveModelRoleConfigurationInput["reasoningEffort"],
  referenceGenerator: SaveModelRoleConfigurationInput["reasoningEffort"],
): SaveModelConfigurationInput {
  const role = (
    reasoningEffort: SaveModelRoleConfigurationInput["reasoningEffort"],
  ): SaveModelRoleConfigurationInput => ({
    endpoint: "https://models.example.com/v1",
    model: "test-model",
    reasoningEffort,
  });
  return {
    orchestrator: role(orchestrator),
    spriteProcessor: role(spriteProcessor),
    referenceGenerator: role(referenceGenerator),
  };
}