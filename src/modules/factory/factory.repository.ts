import { Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { factories } from "../../common/db/schema.js";
import {
  factoryConfigSchema,
  type CreateFactoryInput,
  type FactoryView,
} from "./factory.contracts.js";

@Injectable()
export class FactoryRepository {
  constructor(private readonly connection: DatabaseService) {}

  async list(): Promise<FactoryView[]> {
    const rows = await this.connection.database
      .select()
      .from(factories)
      .where(eq(factories.enabled, true))
      .orderBy(desc(factories.createdAt));
    return rows.map(toFactoryView);
  }

  async findById(id: string): Promise<FactoryView | undefined> {
    const [row] = await this.connection.database
      .select()
      .from(factories)
      .where(eq(factories.id, id))
      .limit(1);
    return row ? toFactoryView(row) : undefined;
  }

  async create(input: CreateFactoryInput): Promise<FactoryView> {
    const createdAt = new Date();
    await this.connection.database.insert(factories).values({
      id: input.id,
      version: input.version,
      displayName: input.displayName,
      config: input.config,
      configSha256: input.configSha256,
      enabled: true,
      createdAt,
    });
    return {
      ...input,
      enabled: true,
      createdAtUtc: createdAt.toISOString(),
    };
  }
}

function toFactoryView(row: typeof factories.$inferSelect): FactoryView {
  return {
    id: row.id,
    version: row.version,
    displayName: row.displayName,
    config: factoryConfigSchema.parse(row.config),
    configSha256: row.configSha256,
    enabled: row.enabled,
    createdAtUtc: row.createdAt.toISOString(),
  };
}
