/**
 * @fileoverview 对声明式 Job 输入生成确定性 Guardrail allow/deny 决策；不保存数据库记录、不创建 Run/Job，
 * 也不执行或访问 Worker 本机工具。
 * @module modules/guardrail/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Run 创建编排在事务内调用 evaluate，随后由 RunRepository 将结果与 Run、Jobs、事件和 outbox
 * 一起持久化。Factory/contract schema 在进入此处前已限制 kind 与 JSON 预算。
 * 输入输出：输入是已解析 GuardrailInput，输出是可审计的 GuardrailEvaluation；不返回工具路径、资源映射
 * 或 Worker 注册状态。
 * 副作用：只计算规范化 SHA-256 与内存决策；持久化由上游事务负责。
 * 安全边界：Guardrail 是 fail-closed 决策，任何命令、脚本、进程或路径语义都必须 deny；allow 只表示
 * payload 是声明式，不能证明 Worker capability、资源证据或部署授权。
 */
import { Injectable } from "@nestjs/common";
import { sha256Json } from "../../common/utils/canonical.js";
import type {
  GuardrailEvaluation,
  GuardrailInput,
} from "./guardrail.contracts.js";
import { containsUnsafeDeclarativeField } from "./guardrail.contracts.js";

@Injectable()
/** Run 创建链路使用的纯决策 Service，不拥有数据库状态。 */
export class GuardrailService {
  /**
   * 对已冻结策略和声明式 payload 生成确定性 Guardrail 决策。
   *
   * 步骤 1：对完整已解析 input 计算 SHA-256，供后续持久化审计绑定；步骤 2：递归检查 payload 是否
   * 包含任意执行/路径字段；步骤 3：仅返回 allow/deny 与稳定 reasonCode，由上游事务决定是否创建 Run。
   * 检测到危险字段时不能继续创建 Worker Job，也不能以“后续会校验”为由返回 allow。
   *
   * @param input 已经过 schema 和 Factory contract 校验的声明式策略/Job 输入。
   * @returns 不含副作用的 GuardrailEvaluation；调用方必须将 deny 视为阻断，而不是可忽略警告。
   */
  evaluate(input: GuardrailInput): GuardrailEvaluation {
    const inputSha256 = sha256Json(input);
    const reasonCode = containsUnsafeDeclarativeField(input.payload)
      ? "ARBITRARY_EXECUTION_FIELD"
      : "REGISTERED_JOB_KIND";
    const decision = reasonCode === "REGISTERED_JOB_KIND" ? "allow" : "deny";
    return {
      policyId: input.policyId,
      policySha256: input.policySha256.toUpperCase(),
      inputSha256,
      decision,
      reasonCode,
    };
  }
}
