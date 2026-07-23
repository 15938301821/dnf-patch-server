/**
 * @fileoverview 装配固定角色、受限模型出站调用的 Provider、审计 Repository、恢复 Service 和编排 Service；
 * 不提供任意 Prompt/模型/工具/网络代理 API，也不存储或回显用户模型密钥。
 * @module modules/openai/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Module；OpenAiService 经 RunModule 验证 Run 上下文，经
 * ModelConfigurationModule 在稳定用户所有权下取得短暂内存凭据，再使用 OpenAiProvider 发起固定角色
 * 请求，并由 OpenAiRepository/RecoveryService 保存受限审计与恢复状态。
 * 输入输出：本文件只定义 Nest provider 图，不解析浏览器凭据、执行 HTTP 调用、返回模型正文或持久化记录。
 * 副作用：启动时注册 provider；真实网络请求、加密解密和数据库写入仅发生在相应 Service 的受控方法中。
 * 安全边界：Module 不把 Provider 或 Cipher 公开成通用出站工具；调用方必须通过导出的 OpenAiService，
 * 以便保留固定角色、超时、响应校验、脱敏审计、Run/用户归属和 fail-closed 条件。
 */
import { Module } from "@nestjs/common";
import { ModelConfigurationModule } from "../model-configuration/model-configuration.module.js";
import { RunModule } from "../run/run.module.js";
import { OpenAiProvider } from "./openai.provider.js";
import { OpenAiRecoveryService } from "./openai-recovery.service.js";
import { OpenAiRepository } from "./openai.repository.js";
import { OpenAiService } from "./openai.service.js";

@Module({
  imports: [ModelConfigurationModule, RunModule],
  providers: [
    OpenAiProvider,
    OpenAiRepository,
    OpenAiRecoveryService,
    OpenAiService,
  ],
  exports: [OpenAiService],
})
/** 固定角色模型调用领域的 Nest 边界，只导出受限 OpenAiService。 */
export class OpenAiModule {}
