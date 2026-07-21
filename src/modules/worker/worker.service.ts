import { ConflictException, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { workers } from "../../common/db/schema.js";
import type { AllowedJobKind } from "../guardrail/guardrail.contracts.js";
import {
  type RegisterWorkerInput,
  type WorkerView,
  workerCapabilitiesSchema,
} from "./worker.contracts.js";
import { validateWorkerReregistration } from "./worker-registration.js";

@Injectable()
export class WorkerService {
  constructor(private readonly connection: DatabaseService) {}

  /** 判断是否有启用的 Worker 声明指定能力；不推断其本机路径或资源内容。 */
  async hasEnabledCapability(capability: AllowedJobKind): Promise<boolean> {
    const rows = await this.connection.database
      .select({ capabilities: workers.capabilities })
      .from(workers)
      .where(eq(workers.disabled, false));
    return rows.some((row) =>
      workerCapabilitiesSchema.parse(row.capabilities).includes(capability),
    );
  }

  async register(input: RegisterWorkerInput): Promise<WorkerView> {
    const now = new Date();
    const capabilities = [...input.capabilities].sort();
    return this.connection.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(workers)
        .where(eq(workers.id, input.id))
        .limit(1)
        .for("update");
      if (existing?.disabled) {
        throw new ConflictException({
          code: "WORKER_DISABLED",
          message: "已禁用 Worker 不能通过重复注册恢复。",
        });
      }
      if (existing) {
        const existingCapabilities = workerCapabilitiesSchema.parse(
          existing.capabilities,
        );
        if (
          validateWorkerReregistration(
            { ...existing, capabilities: existingCapabilities },
            input.displayName,
            capabilities,
          ) !== "accepted"
        ) {
          throw new ConflictException({
            code: "WORKER_REGISTRATION_CONFLICT",
            message: "已注册 Worker 的身份或能力与本次注册不一致。",
          });
        }
        await transaction
          .update(workers)
          .set({ lastHeartbeatAt: now })
          .where(eq(workers.id, input.id));
        return toWorkerView({
          ...existing,
          lastHeartbeatAt: now,
          capabilities: existingCapabilities,
        });
      }
      await transaction.insert(workers).values({
        id: input.id,
        displayName: input.displayName,
        capabilities,
        disabled: false,
        lastHeartbeatAt: now,
        createdAt: now,
      });
      return toWorkerView({
        id: input.id,
        displayName: input.displayName,
        capabilities,
        disabled: false,
        lastHeartbeatAt: now,
        createdAt: now,
      });
    });
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

function toWorkerView(row: typeof workers.$inferSelect): WorkerView {
  return {
    id: row.id,
    displayName: row.displayName,
    capabilities: row.capabilities,
    disabled: row.disabled,
    ...(row.lastHeartbeatAt
      ? { lastHeartbeatAtUtc: row.lastHeartbeatAt.toISOString() }
      : {}),
    createdAtUtc: row.createdAt.toISOString(),
  };
}
