import { ConfigService } from "@nestjs/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createPool, drizzle, pool } = vi.hoisted(() => ({
  createPool: vi.fn(),
  drizzle: vi.fn(),
  pool: {
    pool: { on: vi.fn() },
    end: vi.fn(),
  },
}));

vi.mock("mysql2/promise", () => ({ createPool }));
vi.mock("drizzle-orm/mysql2", () => ({ drizzle }));

import { DatabaseService } from "./database.service.js";

describe("DatabaseService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPool.mockReturnValue(pool);
    drizzle.mockReturnValue({});
  });

  it("initializes every new MySQL session as UTC", () => {
    new DatabaseService(
      new ConfigService({
        DATABASE_URL: "mysql://database.invalid/test",
        DATABASE_POOL_SIZE: 4,
      }),
    );

    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Z" }),
    );
    expect(pool.pool.on).toHaveBeenCalledWith(
      "connection",
      expect.any(Function),
    );

    const initialize = pool.pool.on.mock.calls[0]?.[1] as (connection: {
      query: (statement: string, callback: (error?: Error) => void) => void;
      destroy: () => void;
    }) => void;
    const connection = { query: vi.fn(), destroy: vi.fn() };
    initialize(connection);

    expect(connection.query).toHaveBeenCalledWith(
      "SET SESSION time_zone = '+00:00'",
      expect.any(Function),
    );
    const callback = connection.query.mock.calls[0]?.[1] as (
      error?: Error,
    ) => void;
    callback(new Error("SESSION_TIME_ZONE_REJECTED"));
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});
