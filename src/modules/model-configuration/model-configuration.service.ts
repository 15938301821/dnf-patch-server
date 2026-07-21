/**
 * @fileoverview 编排每用户三角色模型配置、认证加密和脱敏视图；不向 API 回显凭据材料。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import type {
  ModelConfiguration,
  ModelRole,
  ModelRoleConfiguration,
  ResolvedModelRoleConfiguration,
  SaveModelConfigurationInput,
} from "./model-configuration.contracts.js";
import { ModelCredentialCipher } from "./model-credential-cipher.js";
import {
  ModelConfigurationRepository,
  type ModelConfigurationRecord,
  type ModelConfigurationWrite,
} from "./model-configuration.repository.js";

const roles = [
  "orchestrator",
  "spriteProcessor",
  "referenceGenerator",
] as const satisfies readonly ModelRole[];

@Injectable()
export class ModelConfigurationService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    @Inject(ModelConfigurationRepository)
    private readonly configurations: ModelConfigurationRepository,
    @Inject(ModelCredentialCipher)
    private readonly cipher: ModelCredentialCipher,
  ) {}

  async get(userId: string): Promise<ModelConfiguration> {
    return this.toView(await this.configurations.listByUser(userId));
  }

  async save(
    userId: string,
    input: SaveModelConfigurationInput,
  ): Promise<ModelConfiguration> {
    let writes: ModelConfigurationWrite[];
    try {
      writes = roles.map((role) => ({
        role,
        endpoint: input[role].endpoint,
        model: input[role].model,
        ...(input[role].apiKey
          ? {
              credential: this.cipher.encrypt(userId, role, input[role].apiKey),
            }
          : {}),
      }));
    } catch {
      throw new ServiceUnavailableException({
        code: "MODEL_CREDENTIAL_STORAGE_UNAVAILABLE",
        message: "服务端模型凭据加密配置不可用。",
      });
    }
    const records = await this.configurations.saveAll(userId, writes);
    if (!records) {
      throw new BadRequestException({
        code: "MODEL_API_KEY_REQUIRED",
        message: "首次配置每个模型角色时都必须填写 API Key。",
      });
    }
    return this.toView(records);
  }

  async resolve(
    userId: string,
    role: ModelRole,
  ): Promise<ResolvedModelRoleConfiguration | undefined> {
    const record = await this.configurations.findByUserAndRole(userId, role);
    if (!record) return undefined;
    try {
      return {
        endpoint: record.endpoint,
        model: record.model,
        keyConfigured: true,
        apiKey: this.cipher.decrypt(userId, role, record.credential),
        version: record.version,
      };
    } catch {
      throw new Error("MODEL_CREDENTIAL_DECRYPTION_FAILED");
    }
  }

  private toView(records: ModelConfigurationRecord[]): ModelConfiguration {
    const byRole = new Map(records.map((record) => [record.role, record]));
    return {
      orchestrator: this.roleView("orchestrator", byRole),
      spriteProcessor: this.roleView("spriteProcessor", byRole),
      referenceGenerator: this.roleView("referenceGenerator", byRole),
    };
  }

  private roleView(
    role: ModelRole,
    records: ReadonlyMap<ModelRole, ModelConfigurationRecord>,
  ): ModelRoleConfiguration {
    const record = records.get(role);
    if (record) {
      return {
        endpoint: record.endpoint,
        model: record.model,
        keyConfigured: true,
      };
    }
    return {
      endpoint: this.config.getOrThrow("OPENAI_BASE_URL", { infer: true }),
      model: this.config.getOrThrow(modelKeyFor(role), { infer: true }),
      keyConfigured: false,
    };
  }
}

function modelKeyFor(
  role: ModelRole,
):
  | "OPENAI_ORCHESTRATOR_MODEL"
  | "OPENAI_ENGINEER_MODEL"
  | "OPENAI_IMAGE_MODEL" {
  return role === "orchestrator"
    ? "OPENAI_ORCHESTRATOR_MODEL"
    : role === "spriteProcessor"
      ? "OPENAI_ENGINEER_MODEL"
      : "OPENAI_IMAGE_MODEL";
}
