import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import type { Environment } from "../../config/environment.js";
import * as artifactSchema from "./artifact-schema.js";
import * as controlSchema from "./schema.js";
import * as studioSchema from "./studio-schema.js";

const schema = { ...controlSchema, ...artifactSchema, ...studioSchema };

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly database: MySql2Database<typeof schema>;

  constructor(config: ConfigService<Environment, true>) {
    this.pool = createPool({
      uri: config.getOrThrow("DATABASE_URL", { infer: true }),
      connectionLimit: config.getOrThrow("DATABASE_POOL_SIZE", { infer: true }),
      timezone: "Z",
      enableKeepAlive: true,
    });
    this.database = drizzle(this.pool, { schema, mode: "default" });
  }

  async ping(): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.ping();
    } finally {
      connection.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
