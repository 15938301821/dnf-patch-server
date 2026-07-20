import { ConflictException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { CreateInventoryInput, InventoryView } from "./npk.contracts.js";
import { NpkRepository } from "./npk.repository.js";

@Injectable()
export class NpkService {
  constructor(private readonly inventories: NpkRepository) {}

  create(
    projectId: string,
    input: CreateInventoryInput,
  ): Promise<InventoryView> {
    const normalizedPaths = input.entries.map((entry) =>
      entry.internalPath.replaceAll("\\", "/").toLocaleLowerCase(),
    );
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
      throw new ConflictException({
        code: "INVENTORY_PATH_CONFLICT",
        message: "Inventory 中存在重复的 NPK 内部路径。",
      });
    }
    return this.inventories.create(projectId, randomUUID(), input);
  }

  list(projectId: string): Promise<InventoryView[]> {
    return this.inventories.list(projectId);
  }
}
