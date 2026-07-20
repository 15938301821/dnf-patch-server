/**
 * @fileoverview 持久化 Image Attempt 并查询其证据归属，不处理模型调用或图片字节。
 * @module image
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 1 evidence ownership
 */
import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  artifacts,
  imageAttempts,
  modelCalls,
} from "../../common/db/schema.js";
import type {
  CreateImageAttemptInput,
  ImageAttemptView,
} from "./image.contracts.js";

export interface ImageRepositoryPort {
  findArtifactRunId(id: string): Promise<string | undefined>;
  findModelCallRunId(id: string): Promise<string | undefined>;
  create(
    runId: string,
    id: string,
    input: CreateImageAttemptInput,
  ): Promise<ImageAttemptView>;
}

@Injectable()
export class ImageRepository implements ImageRepositoryPort {
  constructor(private readonly connection: DatabaseService) {}

  /** 查询 Artifact 所属 Run；只返回归属信息，不暴露数据库行。 */
  async findArtifactRunId(id: string): Promise<string | undefined> {
    const [row] = await this.connection.database
      .select({ runId: artifacts.runId })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1);
    return row?.runId;
  }

  /** 查询 ModelCall 所属 Run；只返回归属信息，不暴露模型证据正文。 */
  async findModelCallRunId(id: string): Promise<string | undefined> {
    const [row] = await this.connection.database
      .select({ runId: modelCalls.runId })
      .from(modelCalls)
      .where(eq(modelCalls.id, id))
      .limit(1);
    return row?.runId;
  }

  /** 写入已完成归属校验的 Image Attempt 元数据。 */
  async create(
    runId: string,
    id: string,
    input: CreateImageAttemptInput,
  ): Promise<ImageAttemptView> {
    const createdAt = new Date();
    const normalized = {
      ...input,
      promptSha256: input.promptSha256.toUpperCase(),
      inputSnapshotSha256: input.inputSnapshotSha256.toUpperCase(),
      generationConfigSha256: input.generationConfigSha256.toUpperCase(),
      directRuntimeUseAllowed: false as const,
    };
    await this.connection.database.insert(imageAttempts).values({
      id,
      runId,
      ...normalized,
      createdAt,
    });
    return { id, runId, ...normalized, createdAtUtc: createdAt.toISOString() };
  }
}
