/**
 * @fileoverview 持久化 ModelCall 状态与 egress 事实，并回收崩溃遗留的 running 记录。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { Injectable } from "@nestjs/common";
import { and, eq, lt, sql } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { modelCalls } from "../../common/db/schema.js";
import type { ModelCallView, ModelUsage } from "./openai.contracts.js";

export interface ModelCallCompletion {
  status: "passed" | "failed";
  responseSha256?: string;
  responseId?: string;
  errorCode?: string;
  /** Provider 完整返回并经适配层校验的计量；缺失时数据库保持 NULL。 */
  usage?: ModelUsage;
  /** 实际 Provider 调用耗时，单位毫秒；失败请求也可记录，未出站时不得填写。 */
  providerLatencyMs?: number;
}

export interface OpenAiRepositoryPort {
  create(record: ModelCallView): Promise<void>;
  markEgressPerformed(id: string): Promise<boolean>;
  finish(
    id: string,
    result: ModelCallCompletion,
    finishedAt: Date,
  ): Promise<boolean>;
  abandonStale(timeoutMs: number): Promise<number>;
}

@Injectable()
export class OpenAiRepository implements OpenAiRepositoryPort {
  constructor(private readonly connection: DatabaseService) {}

  async create(record: ModelCallView): Promise<void> {
    await this.connection.database.insert(modelCalls).values({
      id: record.id,
      runId: record.runId,
      role: record.role,
      model: record.model,
      endpointIdentity: record.endpointIdentity,
      ...(record.modelConfigurationVersion
        ? { modelConfigurationVersion: record.modelConfigurationVersion }
        : {}),
      requestSha256: record.requestSha256,
      status: record.status,
      modelEgressAuthorized: record.modelEgressAuthorized,
      modelEgressPerformed: record.modelEgressPerformed,
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      createdAt: new Date(record.createdAtUtc),
      ...(record.finishedAtUtc
        ? { finishedAt: new Date(record.finishedAtUtc) }
        : {}),
    });
  }

  async markEgressPerformed(id: string): Promise<boolean> {
    const result = await this.connection.database
      .update(modelCalls)
      .set({ modelEgressPerformed: true })
      .where(
        and(
          eq(modelCalls.id, id),
          eq(modelCalls.status, "running"),
          eq(modelCalls.modelEgressAuthorized, true),
          eq(modelCalls.modelEgressPerformed, false),
        ),
      );
    return result[0].affectedRows === 1;
  }

  async finish(
    id: string,
    completion: ModelCallCompletion,
    finishedAt: Date,
  ): Promise<boolean> {
    const result = await this.connection.database
      .update(modelCalls)
      .set({
        status: completion.status,
        finishedAt,
        ...(completion.responseSha256
          ? { responseSha256: completion.responseSha256 }
          : {}),
        ...(completion.responseId ? { responseId: completion.responseId } : {}),
        ...(completion.errorCode ? { errorCode: completion.errorCode } : {}),
        ...(completion.usage
          ? {
              inputTokens: completion.usage.inputTokens,
              outputTokens: completion.usage.outputTokens,
              totalTokens: completion.usage.totalTokens,
            }
          : {}),
        ...(completion.providerLatencyMs !== undefined
          ? { providerLatencyMs: completion.providerLatencyMs }
          : {}),
      })
      .where(and(eq(modelCalls.id, id), eq(modelCalls.status, "running")));
    return result[0].affectedRows === 1;
  }

  /** 使用数据库时间回收超过 SDK 最大请求窗口的 running 记录。 */
  async abandonStale(timeoutMs: number): Promise<number> {
    const thresholdMicroseconds = timeoutMs * 1_000;
    const result = await this.connection.database
      .update(modelCalls)
      .set({
        status: "abandoned",
        errorCode: "MODEL_CALL_ABANDONED_AFTER_RESTART",
        finishedAt: sql`CURRENT_TIMESTAMP(3)`,
      })
      .where(
        and(
          eq(modelCalls.status, "running"),
          lt(
            modelCalls.createdAt,
            sql`DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${thresholdMicroseconds} MICROSECOND)`,
          ),
        ),
      );
    return result[0].affectedRows;
  }
}
