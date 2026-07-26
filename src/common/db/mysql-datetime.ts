/**
 * @fileoverview 将 mysql2/Drizzle 返回的 DATETIME 值统一解释为 UTC；不读取数据库或进程时区。
 * @module common/db/mysql-datetime
 *
 * MySQL DATETIME 不携带时区。DatabaseService 将每个会话固定为 UTC，因此 raw SQL 返回的
 * `YYYY-MM-DD HH:mm:ss(.fff)` 字符串也必须按 UTC 解释，不能交给依赖主机本地时区的 Date parser。
 */

const mysqlDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/u;

/** 将数据库映射的 Date 或无时区 MySQL DATETIME 字符串转换为 UTC Date。 */
export function databaseUtcDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error("DATABASE_TIME_INVALID");
    return value;
  }

  const match = mysqlDateTimePattern.exec(value);
  if (match) {
    const year = match[1];
    const month = match[2];
    const day = match[3];
    const hour = match[4];
    const minute = match[5];
    const second = match[6];
    if (!year || !month || !day || !hour || !minute || !second) {
      throw new Error("DATABASE_TIME_INVALID");
    }
    const fraction = match[7] ?? "";
    const normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0").slice(0, 3)}Z`;
    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.getTime()))
      throw new Error("DATABASE_TIME_INVALID");
    return parsed;
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("DATABASE_TIME_INVALID");
  return parsed;
}
