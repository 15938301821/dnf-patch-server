/**
 * @fileoverview 装配用户模型配置的认证、凭据加密、持久化和 HTTP 管理接口；不提供通用模型代理、
 * 不把明文密钥暴露给其他模块，也不替代每次调用时的稳定用户所有权校验。
 * @module modules/model-configuration/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；ModelConfigurationController 通过 AuthModule 的身份能力将认证用户
 * 传给 ModelConfigurationService；Service 使用 ModelCredentialCipher 加密/解密，并通过 Repository 持久化
 * 用户拥有的密文配置；OpenAiModule 仅使用导出的 Service 获取受限调用上下文。
 * 输入输出：本文件只声明 Nest 依赖图，不接收密钥、返回密文、执行模型请求或直接操作数据库。
 * 副作用：应用启动时注册 provider/controller；没有即时写入配置、加密/解密或网络外发。
 * 安全边界：AuthModule 认证不等于资源可读，Service 必须对稳定 userId 执行所有权校验；Module 不导出
 * Repository、Cipher 或任何密钥材料，避免跨模块绕过脱敏 ViewModel 和认证加密边界。
 */
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { ModelCredentialCipher } from "./model-credential-cipher.js";
import { ModelConfigurationController } from "./model-configuration.controller.js";
import { ModelConfigurationRepository } from "./model-configuration.repository.js";
import { ModelConfigurationService } from "./model-configuration.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ModelConfigurationController],
  providers: [
    ModelCredentialCipher,
    ModelConfigurationRepository,
    ModelConfigurationService,
  ],
  exports: [ModelConfigurationService],
})
/** 模型配置领域的依赖注入边界，只导出受所有权保护的 ModelConfigurationService。 */
export class ModelConfigurationModule {}
