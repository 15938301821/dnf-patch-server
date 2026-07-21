/**
 * @fileoverview 定义浏览器模型配置视图；服务端配置由环境变量托管，不保存 API Key。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import { z } from "zod";

const roleInputSchema = z
  .object({
    endpoint: z.url(),
    model: z.string().trim().min(1).max(120),
    apiKey: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict();

export const saveModelConfigurationSchema = z
  .object({
    orchestrator: roleInputSchema,
    spriteProcessor: roleInputSchema,
    referenceGenerator: roleInputSchema,
  })
  .strict();

export type SaveModelConfigurationInput = z.infer<
  typeof saveModelConfigurationSchema
>;

export interface ModelRoleConfiguration {
  endpoint: string;
  model: string;
  keyConfigured: boolean;
  keyPreview?: string;
}

export interface ModelConfiguration {
  orchestrator: ModelRoleConfiguration;
  spriteProcessor: ModelRoleConfiguration;
  referenceGenerator: ModelRoleConfiguration;
}
