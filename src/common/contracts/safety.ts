/**
 * @fileoverview 定义普通 API 永远不可提升的安全证明状态；不执行部署、覆盖率或兼容性核验。
 * @module common/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：写入 DTO、Service 与数据库 schema 共同消费该契约。输入来自外部或持久化 JSON，
 * 输出只可能包含四个 false 字段，无副作用。安全边界：这些字段表示尚无外部核验证据，普通
 * API、Worker 或模型都不能将其提升为 true；未知字段也必须拒绝。
 */
import { z } from "zod";

/** 普通 API 安全状态 schema；严格对象保证调用方不能夹带其他证明字段。 */
export const immutableSafetyStateSchema = z
  .object({
    /** 生产方固定为 false；消费方不得据此授权部署。 */
    deploymentAuthorized: z.literal(false).default(false),
    /** 生产方固定为 false；不表示 Worker 或用户已执行部署。 */
    deploymentPerformed: z.literal(false).default(false),
    /** 生产方固定为 false；不表示职业全部技能已有可验证产物。 */
    fullSkillCoverageProven: z.literal(false).default(false),
    /** 生产方固定为 false；不表示候选 NPK 已通过真实客户端验证。 */
    clientCompatibilityProven: z.literal(false).default(false),
  })
  .strict();

/** schema 解析后的不可提升状态，供 DTO/ViewModel 组合使用，不是数据库行。 */
export type ImmutableSafetyState = z.infer<typeof immutableSafetyStateSchema>;
