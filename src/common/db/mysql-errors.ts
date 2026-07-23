/**
 * @fileoverview 识别 mysql2/Drizzle 错误因果链中的重复唯一键错误；不返回驱动对象、不解析 SQL，
 * 也不把其他数据库失败错误映射为业务成功。
 * @module common/db
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Repository/Service 在捕获 unknown 数据库异常后调用 isMysqlDuplicateEntry，再映射为
 * 稳定冲突码。输入是任意异常，输出是布尔判断，无副作用。安全边界：最多检查四层 cause，避免
 * 无界/循环遍历；false 表示无法证明重复键，调用方必须 fail-closed 而非猜测冲突语义。
 */

/** mysql2 或包装层错误的最小只读视图，不信任 message、SQL 或其他驱动字段。 */
interface ErrorWithCode {
  /** mysql2 稳定错误 code；仅精确匹配 ER_DUP_ENTRY。 */
  code?: unknown;
  /** 包装层可选原始原因；递归深度由调用函数限制。 */
  cause?: unknown;
}

/**
 * 在有界 cause 链中识别 MySQL `ER_DUP_ENTRY`。
 * @param error Repository 捕获的 unknown 异常，可能由 Drizzle 或 mysql2 包装。
 * @returns 前四层任一对象 code 精确匹配时为 true，否则为 false；不泄露错误内容。
 */
export function isMysqlDuplicateEntry(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const candidate = current as ErrorWithCode;
    if (candidate.code === "ER_DUP_ENTRY") return true;
    current = candidate.cause;
  }
  return false;
}
