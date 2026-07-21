/**
 * @fileoverview 映射环境托管的三角色模型配置；不存储或回显模型 API Key。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import { ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import type {
  ModelConfiguration,
  ModelRoleConfiguration,
  SaveModelConfigurationInput,
} from "./model-configuration.contracts.js";

@Injectable()
export class ModelConfigurationService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  get(): ModelConfiguration {
    return {
      orchestrator: this.role("OPENAI_ORCHESTRATOR_MODEL"),
      spriteProcessor: this.role("OPENAI_ENGINEER_MODEL"),
      referenceGenerator: this.role("OPENAI_IMAGE_MODEL"),
    };
  }

  save(input: SaveModelConfigurationInput): ModelConfiguration {
    if (hasApiKey(input)) {
      throw new ConflictException({
        code: "MODEL_CONFIGURATION_ENV_MANAGED",
        message: "模型 API Key 由服务端环境变量托管，不能通过浏览器保存。",
      });
    }
    return this.get();
  }

  private role(
    modelKey:
      | "OPENAI_ORCHESTRATOR_MODEL"
      | "OPENAI_ENGINEER_MODEL"
      | "OPENAI_IMAGE_MODEL",
  ): ModelRoleConfiguration {
    const apiKey = this.config.get("OPENAI_API_KEY", { infer: true });
    const keyConfigured = typeof apiKey === "string" && apiKey.length > 0;
    return {
      endpoint: this.config.getOrThrow("OPENAI_BASE_URL", { infer: true }),
      model: this.config.getOrThrow(modelKey, { infer: true }),
      keyConfigured,
      ...(keyConfigured ? { keyPreview: "configured" } : {}),
    };
  }
}

function hasApiKey(input: SaveModelConfigurationInput): boolean {
  return [
    input.orchestrator.apiKey,
    input.spriteProcessor.apiKey,
    input.referenceGenerator.apiKey,
  ].some((value) => typeof value === "string" && value.trim().length > 0);
}
