/**
 * @fileoverview 定义提交后可靠通知使用的 outbox_events 表；不发布事件、不执行查询或业务事务。
 * @module common/db/outbox-schema
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - Server schema 文件职责拆分
 *
 * 调用关系：Run Repository 与 dispatcher 经统一 schema 入口读写本表，drizzle-kit 消费表定义。
 * 输入输出：业务 transaction 写入已校验事件，dispatcher 读取并标记发布时间；输出是内部数据库行。
 * 副作用与安全边界：定义本身无 I/O；事件必须与业务状态同事务写入，提交前不得广播，payload
 * 写入前和读取后都要运行时校验，未发布记录允许幂等重试但不能成为业务状态事实源。
 */
import {
  datetime,
  index,
  json,
  mysqlTable,
  varchar,
} from "drizzle-orm/mysql-core";

/** 与业务状态同事务写入、由 dispatcher 在提交后发布的权威通知队列。 */
export const outboxEvents = mysqlTable(
  "outbox_events",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    topic: varchar("topic", { length: 120 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 64 }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(),
    publishedAt: datetime("published_at", { mode: "date", fsp: 3 }),
  },
  (table) => [
    index("outbox_pending_idx").on(table.publishedAt, table.createdAt),
  ],
);
