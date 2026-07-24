/**
 * @fileoverview 为 Profession 单技能固定模型步骤提供 Nest Repository 边界；不调用模型、对象存储
 * 或本机工具，也不承载 HTTP 错误映射。
 * @module modules/job/profession-model-execution-repository
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：ProfessionExecutionService 注入本 provider；本类把已校验的 lease DTO 和 Server 生成的
 * 证据标识委托给同模块 transaction support。输入输出均为有限领域状态，不暴露数据库行。
 * 副作用：每个公开方法开启由 support 定义的 Drizzle transaction、取得行锁并持久化执行证据。
 * 安全边界：Repository 是数据库事务边界，不是出站授权本身；精确 lease fencing、唯一出站权、
 * 配额和 Artifact/ImageAttempt 原子写入仍必须由 support fail-closed 校验。
 */
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../common/db/database.service.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import type {
  FinalizeProfessionModelOutputInput,
  ProfessionModelExecutionStage,
  ProfessionModelOutputEvidence,
  ReserveProfessionModelExecutionResult,
} from "./profession-model-execution.js";
import * as executionSupport from "./profession-model-execution.repository-support.js";

/** Profession 固定模型执行的模块内持久化 provider，不向其他 Nest module 导出。 */
@Injectable()
export class ProfessionModelExecutionRepository {
  /** @param connection 应用共享的 Drizzle 数据库连接；事务由各方法的 support 函数拥有。 */
  constructor(private readonly connection: DatabaseService) {}

  /** @returns 当前 attempt 的幂等执行状态，只有 `execute` 授予一次模型出站机会。 */
  reserveProfessionSkillModelExecution(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: ProfessionModelExecutionStage,
  ): Promise<ReserveProfessionModelExecutionResult> {
    return executionSupport.reserveProfessionSkillModelExecution(
      this.connection,
      jobId,
      input,
      stage,
    );
  }

  /** @returns ModelCall 与唯一 egressing execution 属于同一 Run 时为 accepted。 */
  bindProfessionModelCallBeforeEgress(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: ProfessionModelExecutionStage,
    modelCallId: string,
  ): Promise<"accepted" | "rejected"> {
    return executionSupport.bindProfessionModelCallBeforeEgress(
      this.connection,
      executionId,
      input,
      stage,
      modelCallId,
    );
  }

  /** @returns 输出证据匹配且 Run 剩余对象配额足够时保留持久化额度。 */
  prepareProfessionModelOutputPersistence(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: ProfessionModelExecutionStage,
    evidence: ProfessionModelOutputEvidence,
    maxRunBytes: number,
  ): Promise<"accepted" | "rejected" | "run-quota-exceeded"> {
    return executionSupport.prepareProfessionModelOutputPersistence(
      this.connection,
      executionId,
      input,
      stage,
      evidence,
      maxRunBytes,
    );
  }

  /** @returns Artifact/ImageAttempt 与 execution 终态在同一事务提交时为 accepted。 */
  finalizeProfessionModelOutput(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    output: FinalizeProfessionModelOutputInput,
  ): Promise<"accepted" | "rejected"> {
    return executionSupport.finalizeProfessionModelOutput(
      this.connection,
      executionId,
      input,
      output,
    );
  }

  /** @returns 当前非终态 execution 被同一 lease 终结时为 true；终态重复请求返回 false。 */
  failProfessionModelExecution(
    executionId: string,
    input: RequestProfessionSkillExecutionInput,
    stage: ProfessionModelExecutionStage,
    errorCode: string,
    indeterminate: boolean,
    modelCallId?: string,
  ): Promise<boolean> {
    return executionSupport.failProfessionModelExecution(
      this.connection,
      executionId,
      input,
      stage,
      errorCode,
      indeterminate,
      modelCallId,
    );
  }
}
