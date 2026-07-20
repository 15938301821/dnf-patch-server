import { Injectable } from "@nestjs/common";
import { sha256Json } from "../../common/utils/canonical.js";
import type {
  GuardrailEvaluation,
  GuardrailInput,
} from "./guardrail.contracts.js";
import { containsUnsafeDeclarativeField } from "./guardrail.contracts.js";

@Injectable()
export class GuardrailService {
  /**
   * Guardrail 只允许声明式任务参数。检测到命令、脚本或游戏路径字段时硬拒绝，
   * 这里只生成确定性决策，Run Repository 会在同一事务中保存决策和 Run。
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
