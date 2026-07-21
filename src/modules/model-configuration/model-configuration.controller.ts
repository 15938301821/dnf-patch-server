/**
 * @fileoverview 暴露当前浏览器用户的模型配置读取与保存；响应不回显 API Key 或密文材料。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import { Body, Controller, Get, Headers, Put } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { AuthService } from "../auth/auth.service.js";
import {
  saveModelConfigurationSchema,
  type ModelConfiguration,
  type SaveModelConfigurationInput,
} from "./model-configuration.contracts.js";
import { ModelConfigurationService } from "./model-configuration.service.js";

@Controller("users/me/model-configuration")
export class ModelConfigurationController {
  constructor(
    private readonly models: ModelConfigurationService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async get(
    @Headers("authorization") authorization: string | undefined,
  ): Promise<{ data: ModelConfiguration }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.models.get(user.id) };
  }

  @Put()
  async save(
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(saveModelConfigurationSchema))
    input: SaveModelConfigurationInput,
  ): Promise<{ data: ModelConfiguration }> {
    const user = await this.auth.requireBrowserUser(authorization);
    return { data: await this.models.save(user.id, input) };
  }
}
