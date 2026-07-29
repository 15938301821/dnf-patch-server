import { describe, expect, it } from "vitest";
import { databaseUtcDate } from "../../../src/common/db/mysql-datetime.js";

describe("databaseUtcDate", () => {
  it("interprets a timezone-free MySQL DATETIME as UTC", () => {
    expect(databaseUtcDate("2026-07-25 05:19:58.778").toISOString()).toBe(
      "2026-07-25T05:19:58.778Z",
    );
  });

  it("normalizes MySQL fractional seconds to JavaScript milliseconds", () => {
    expect(databaseUtcDate("2026-07-25 05:19:58.7").toISOString()).toBe(
      "2026-07-25T05:19:58.700Z",
    );
    expect(databaseUtcDate("2026-07-25 05:19:58.778999").toISOString()).toBe(
      "2026-07-25T05:19:58.778Z",
    );
  });

  it("preserves mapped Date values and rejects invalid strings", () => {
    const mapped = new Date("2026-07-25T05:19:58.778Z");
    expect(databaseUtcDate(mapped)).toBe(mapped);
    expect(() => databaseUtcDate("not-a-database-time")).toThrow(
      "DATABASE_TIME_INVALID",
    );
  });
});
