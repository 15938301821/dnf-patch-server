import { describe, expect, it } from "vitest";
import { validateEnvironment } from "./environment.js";

function validEnvironment(): Record<string, unknown> {
  return {
    DATABASE_URL: "mysql://runtime-user@127.0.0.1:3306/dnf_patch",
    CLIENT_SHARED_TOKEN: "c".repeat(32),
    WORKER_SHARED_TOKEN: "x".repeat(32),
  };
}

describe("environment configuration", () => {
  it("applies loopback-safe defaults", () => {
    expect(validateEnvironment(validEnvironment())).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 56_789,
      OPENAI_BASE_URL: "https://kldai.cc/v1",
      OUTBOX_DISPATCH_INTERVAL_MS: 1_000,
      OUTBOX_DISPATCH_BATCH_SIZE: 25,
      WORKER_REAPER_INTERVAL_MS: 5_000,
      WORKER_REAPER_BATCH_SIZE: 25,
      RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: false,
    });
  });

  it("rejects a public bind address", () => {
    expect(() =>
      validateEnvironment({ ...validEnvironment(), HOST: "0.0.0.0" }),
    ).toThrow();
  });

  it("rejects a short worker credential", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        WORKER_SHARED_TOKEN: "short",
      }),
    ).toThrow();
  });

  it("rejects shared client and worker credentials", () => {
    const token = "shared-token".repeat(3);
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        CLIENT_SHARED_TOKEN: token,
        WORKER_SHARED_TOKEN: token,
      }),
    ).toThrow();
  });

  it("requires project and snapshot identifiers when resource import is enabled", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: "true",
      }),
    ).toThrow();

    expect(
      validateEnvironment({
        ...validEnvironment(),
        RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: "true",
        RESOURCE_IMPORT_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
        RESOURCE_IMPORT_SNAPSHOT_ID: "22222222-2222-4222-8222-222222222222",
      }).RESOURCE_IMPORT_SERVER_MIRROR_ENABLED,
    ).toBe(true);
  });
});
