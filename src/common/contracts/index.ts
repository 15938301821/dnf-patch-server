/**
 * @fileoverview 汇总跨模块可复用的基础契约入口；不定义领域 DTO、数据库行或业务状态机。
 * @module common/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：领域 contracts、Service 与 Repository 从此处消费基础 schema；定义仍由同目录源文件
 * 维护。输入输出均为类型或 Zod schema，无运行时 I/O。安全边界：重导出不得绕过路径、JSON
 * 预算、安全状态与精确租约校验，也不得把模块内部持久化类型提升为公共契约。
 */

/** 导出 ID、哈希、有界 JSON、显示名与仓库相对路径的运行时输入边界。 */
export {
  boundedJsonRecordSchema,
  clientIdSchema,
  idSchema,
  repositoryRelativePathSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "./primitives.js";
/** 导出普通 API 永远不能提升的四项安全状态及其解析后类型。 */
export {
  immutableSafetyStateSchema,
  type ImmutableSafetyState,
} from "./safety.js";
/** 导出带副作用 Worker 写入必须使用的精确租约 fencing 判定。 */
export {
  hasExactJobLease,
  type ExactJobLeaseInput,
  type ExactJobLeaseState,
} from "./job-lease.js";
