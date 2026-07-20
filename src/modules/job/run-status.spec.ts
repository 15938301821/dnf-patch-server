import { describe, expect, it } from "vitest";
import { aggregateRunStatus } from "./run-status.js";

describe("aggregateRunStatus", () => {
  it("waits until every job reaches a terminal state", () => {
    expect(aggregateRunStatus([])).toBeUndefined();
    expect(aggregateRunStatus(["passed", "queued"])).toBeUndefined();
    expect(aggregateRunStatus(["passed", "leased"])).toBeUndefined();
  });

  it("passes only when every job passes", () => {
    expect(aggregateRunStatus(["passed", "passed"])).toBe("passed");
  });

  it("gives failure precedence over blocked jobs", () => {
    expect(aggregateRunStatus(["passed", "blocked"])).toBe("blocked");
    expect(aggregateRunStatus(["blocked", "failed"])).toBe("failed");
  });
});
