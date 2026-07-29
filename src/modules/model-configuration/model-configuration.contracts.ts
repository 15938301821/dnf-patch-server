/**
 * @fileoverview 定义每用户固定角色模型配置写入 DTO 与脱敏视图；响应不含 API Key 或密文材料。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import { z } from "zod";
import { resolveOpenAiEndpoint } from "../../config/openai-endpoint.js";

export const modelRoleSchema = z.enum([
  "orchestrator",
  "spriteProcessor",
  "referenceGenerator",
]);

export type ModelRole = z.infer<typeof modelRoleSchema>;

/** 持久化推理强度；default 仅兼容图片角色和历史文本记录。 */
export const modelReasoningEffortSchema = z.enum([
  "default",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export type ModelReasoningEffort = z.infer<typeof modelReasoningEffortSchema>;

const modelEndpointSchema = z
  .string()
  .trim()
  .max(500)
  .superRefine((value, context) => {
    try {
      resolveOpenAiEndpoint(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "模型端点无效。",
      });
    }
  });

export const saveModelRoleConfigurationSchema = z
  .object({
    endpoint: modelEndpointSchema,
    model: z.string().trim().min(1).max(120),
    reasoningEffort: modelReasoningEffortSchema,
    apiKey: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.trim().length > 0, "API Key 不能为空。")
      .optional(),
  })
  .strict();

export const saveModelConfigurationSchema = z
  .object({
    orchestrator: saveModelRoleConfigurationSchema,
    spriteProcessor: saveModelRoleConfigurationSchema,
    referenceGenerator: saveModelRoleConfigurationSchema,
  })
  .strict()
  .superRefine((input, context) => {
    for (const role of ["orchestrator", "spriteProcessor"] as const) {
      if (input[role].reasoningEffort === "default") {
        context.addIssue({
          code: "custom",
          path: [role, "reasoningEffort"],
          message: "文本模型必须选择明确的推理强度。",
        });
      }
    }
    if (input.referenceGenerator.reasoningEffort !== "default") {
      context.addIssue({
        code: "custom",
        path: ["referenceGenerator", "reasoningEffort"],
        message: "图片生成角色仅支持接口默认推理强度。",
      });
    }
  });

export type SaveModelRoleConfigurationInput = z.infer<
  typeof saveModelRoleConfigurationSchema
>;
export type SaveModelConfigurationInput = z.infer<
  typeof saveModelConfigurationSchema
>;
export interface ModelRoleConfiguration {
  endpoint: string;
  model: string;
  reasoningEffort: ModelReasoningEffort;
  keyConfigured: boolean;
}

export interface ModelConfiguration {
  orchestrator: ModelRoleConfiguration;
  spriteProcessor: ModelRoleConfiguration;
  referenceGenerator: ModelRoleConfiguration;
}

export interface ResolvedModelRoleConfiguration extends ModelRoleConfiguration {
  apiKey: string;
  version: number;
}
