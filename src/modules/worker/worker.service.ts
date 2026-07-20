import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { workers } from "../../common/db/schema.js";
import type { RegisterWorkerInput, WorkerView } from "./worker.contracts.js";

@Injectable()
export class WorkerService {
  constructor(private readonly connection: DatabaseService) {}

  async register(input: RegisterWorkerInput): Promise<WorkerView> {
    const createdAt = new Date();
    await this.connection.database
      .insert(workers)
      .values({
        id: input.id,
        displayName: input.displayName,
        capabilities: input.capabilities,
        disabled: false,
        lastHeartbeatAt: createdAt,
        createdAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          displayName: input.displayName,
          capabilities: input.capabilities,
          disabled: false,
          lastHeartbeatAt: createdAt,
        },
      });
    return {
      id: input.id,
      displayName: input.displayName,
      capabilities: input.capabilities,
      disabled: false,
      lastHeartbeatAtUtc: createdAt.toISOString(),
      createdAtUtc: createdAt.toISOString(),
    };
  }

  async disable(id: string): Promise<void> {
    await this.connection.database
      .update(workers)
      .set({ disabled: true })
      .where(eq(workers.id, id));
  }

  async heartbeat(id: string): Promise<boolean> {
    const result = await this.connection.database
      .update(workers)
      .set({ lastHeartbeatAt: new Date() })
      .where(and(eq(workers.id, id), eq(workers.disabled, false)));
    return result[0].affectedRows === 1;
  }
}
