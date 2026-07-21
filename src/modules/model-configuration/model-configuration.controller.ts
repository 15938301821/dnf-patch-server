/**
 * @fileoverview 暴露前端模型配置兼容接口，返回环境托管状态并拒绝浏览器保存 API Key。
 * @module model-configuration
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 模型设置需求）
 */
import { Body, Controller, Get, Put } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  saveModelConfigurationSchema,
  type ModelConfiguration,
  type SaveModelConfigurationInput,
} from "./model-configuration.contracts.js";
import { ModelConfigurationService } from "./model-configuration.service.js";

@Controller("users/me/model-configuration")
export class ModelConfigurationController {
  constructor(private readonly models: ModelConfigurationService) {}

  @Get()
  get(): { data: ModelConfiguration } {
    return { data: this.models.get() };
  }

  @Put()
  save(
    @Body(new ZodValidationPipe(saveModelConfigurationSchema))
    input: SaveModelConfigurationInput,
  ): { data: ModelConfiguration } {
    return { data: this.models.save(input) };
  }
}
