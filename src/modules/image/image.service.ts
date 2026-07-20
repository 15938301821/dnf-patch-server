import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import { imageAttempts } from "../../common/db/schema.js";
import type {
  CreateImageAttemptInput,
  ImageAttemptView,
} from "./image.contracts.js";

@Injectable()
export class ImageService {
  constructor(private readonly connection: DatabaseService) {}

  async create(
    runId: string,
    input: CreateImageAttemptInput,
  ): Promise<ImageAttemptView> {
    const id = randomUUID();
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
