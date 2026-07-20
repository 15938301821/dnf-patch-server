/**
 * @fileoverview 查询待发布 Run outbox 并条件标记投递完成，不执行 WebSocket 广播。
 * @module run
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 transactional outbox
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { outboxEvents } from "../../common/db/schema.js";

export interface PendingOutboxRow {
  id: string;
  topic: string;
  aggregateId: string;
  payload: unknown;
}

export interface RunOutboxRepositoryPort {
  listPending(limit: number): Promise<PendingOutboxRow[]>;
  markPublished(id: string): Promise<boolean>;
}

/** 只管理 Run 模块拥有的 run.event outbox 记录。 */
@Injectable()
export class RunOutboxRepository implements RunOutboxRepositoryPort {
  constructor(private readonly connection: DatabaseService) {}

  /** 按稳定顺序读取一个有界 pending 批次，并保留 JSON 为 unknown 供上层校验。 */
  async listPending(limit: number): Promise<PendingOutboxRow[]> {
    return this.connection.database
      .select({
        id: outboxEvents.id,
        topic: outboxEvents.topic,
        aggregateId: outboxEvents.aggregateId,
        payload: outboxEvents.payload,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.topic, "run.event"),
          isNull(outboxEvents.publishedAt),
        ),
      )
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(limit);
  }

  /** 仅将仍为 pending 的 run.event 条件更新为已发布。 */
  async markPublished(id: string): Promise<boolean> {
    const result = await this.connection.database
      .update(outboxEvents)
      .set({ publishedAt: sql`CURRENT_TIMESTAMP(3)` })
      .where(
        and(
          eq(outboxEvents.id, id),
          eq(outboxEvents.topic, "run.event"),
          isNull(outboxEvents.publishedAt),
        ),
      );
    return result[0].affectedRows === 1;
  }
}
