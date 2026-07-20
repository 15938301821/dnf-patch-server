import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ArtifactService } from "../artifact/artifact.service.js";
import { RunService } from "../run/run.service.js";
import {
  normalizeNpkInternalPath,
  type CreateInventoryInput,
  type InventoryView,
} from "./npk.contracts.js";
import { NpkRepository, type NpkRepositoryPort } from "./npk.repository.js";

interface RunLookupPort {
  get(id: string): ReturnType<RunService["get"]>;
}

interface ArtifactLookupPort {
  findRunId(id: string): Promise<string | undefined>;
}

@Injectable()
export class NpkService {
  constructor(
    @Inject(NpkRepository)
    private readonly inventories: NpkRepositoryPort,
    @Inject(RunService) private readonly runs: RunLookupPort,
    @Inject(ArtifactService) private readonly artifacts: ArtifactLookupPort,
  ) {}

  async create(
    projectId: string,
    input: CreateInventoryInput,
  ): Promise<InventoryView> {
    const run = await this.runs.get(input.runId);
    if (run.projectId !== projectId) {
      throw new ConflictException({
        code: "INVENTORY_RUN_PROJECT_MISMATCH",
        message: "Inventory 的 producing Run 不属于目标项目。",
      });
    }
    if (input.inventoryArtifactId) {
      const artifactRunId = await this.artifacts.findRunId(
        input.inventoryArtifactId,
      );
      if (!artifactRunId) {
        throw new NotFoundException({
          code: "INVENTORY_ARTIFACT_NOT_FOUND",
          message: "Inventory 引用的来源 Artifact 不存在。",
        });
      }
      if (artifactRunId !== input.runId) {
        throw new ConflictException({
          code: "INVENTORY_ARTIFACT_RUN_MISMATCH",
          message: "Inventory 引用的来源 Artifact 不属于 producing Run。",
        });
      }
    }
    const normalizedPaths = input.entries.map((entry) =>
      normalizeNpkInternalPath(entry.internalPath),
    );
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
      throw new ConflictException({
        code: "INVENTORY_PATH_CONFLICT",
        message: "Inventory 中存在重复的 NPK 内部路径。",
      });
    }
    return this.inventories.create(projectId, input.runId, randomUUID(), input);
  }

  list(projectId: string): Promise<InventoryView[]> {
    return this.inventories.list(projectId);
  }
}
