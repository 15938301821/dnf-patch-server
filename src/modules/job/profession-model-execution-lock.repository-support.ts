/**
 * @fileoverview 在 Profession 模型状态事务中按固定 stage 锁定 execution 与所属 Job，并复核当前
 * Worker lease；不创建模型调用、不写 Artifact，也不接收 Worker 自定义 stage。
 * @module modules/job/profession-model-execution-lock
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：模型执行 Repository support 的绑定、持久化、终态和失败函数共享本门禁。输入为
 * Server 代码选定的 stage 与经 HTTP schema 校验的 lease DTO，输出为事务内锁定行或 undefined。
 * 副作用：按 Job -> execution 固定顺序取得行锁并读取数据库时间；不提交独立事务。
 * 安全边界：stage、Job/Run、workerId、leaseId、attempt、skillId 和数据库时间租约必须全部匹配，
 * 任一漂移都 fail-closed；调用方不能用 TypeScript 类型替代数据库行复核。
 */
import { eq } from "drizzle-orm";
import { jobs } from "../../common/db/schema.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import { resolveProfessionExecutionContext } from "./profession-execution-context.js";
import type { ProfessionModelExecutionStage } from "./profession-model-execution.js";
import { databaseNow } from "./job-run-event.repository-support.js";
import type { JobTransaction } from "./job-run-event.repository-support.js";

/** 事务锁保护下的 Job、execution 和数据库时间；只在当前 transaction 生命周期内有效。 */
export interface LockedProfessionModelExecution {
  job: typeof jobs.$inferSelect;
  execution: typeof professionSkillModelExecutions.$inferSelect;
  now: Date;
}

/**
 * 以固定锁顺序复核 execution 的完整阶段身份和当前 Job lease。
 * @param transaction 调用方已开启、尚未提交的 Drizzle transaction。
 * @param executionId Server reservation 返回的 execution UUID，不来自 Worker 自由选择。
 * @param input 当前 claim 的 Worker、lease、attempt 与冻结 skill DTO。
 * @param expectedStage Server 编排代码固定的 Engineer 或 Artist stage。
 * @returns 全部绑定有效时返回锁定行；缺失、漂移、过期或 payload 不完整时返回 undefined。
 */
export async function lockedProfessionModelExecution(
  transaction: JobTransaction,
  executionId: string,
  input: RequestProfessionSkillExecutionInput,
  expectedStage: ProfessionModelExecutionStage,
): Promise<LockedProfessionModelExecution | undefined> {
  const [locator] = await transaction
    .select({ jobId: professionSkillModelExecutions.jobId })
    .from(professionSkillModelExecutions)
    .where(eq(professionSkillModelExecutions.id, executionId))
    .limit(1);
  if (!locator) return undefined;

  // Job 是租约权威记录，先锁它可阻止 reaper/complete 与本次阶段状态并发漂移。
  const [job] = await transaction
    .select()
    .from(jobs)
    .where(eq(jobs.id, locator.jobId))
    .limit(1)
    .for("update");
  if (!job) return undefined;
  const [execution] = await transaction
    .select()
    .from(professionSkillModelExecutions)
    .where(eq(professionSkillModelExecutions.id, executionId))
    .limit(1)
    .for("update");
  if (
    !execution ||
    execution.jobId !== job.id ||
    execution.runId !== job.runId ||
    execution.workerId !== input.workerId ||
    execution.leaseId !== input.leaseId ||
    execution.attempt !== input.attempt ||
    execution.skillId !== input.skillId ||
    execution.stage !== expectedStage
  ) {
    return undefined;
  }
  const now = await databaseNow(transaction);
  const gate = resolveProfessionExecutionContext(job, input, now);
  return gate.status === "accepted" ? { job, execution, now } : undefined;
}
