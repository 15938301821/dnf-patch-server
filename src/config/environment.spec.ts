import { describe, expect, it } from "vitest";
import { validateEnvironment } from "./environment.js";

function validEnvironment(): Record<string, unknown> {
  return {
    DATABASE_URL: "mysql://runtime-user@127.0.0.1:3306/dnf_patch",
    CLIENT_SHARED_TOKEN: "c".repeat(32),
    WORKER_SHARED_TOKEN: "x".repeat(32),
    BROWSER_SESSION_SECRET: "s".repeat(32),
  };
}

describe("environment configuration", () => {
  it("applies loopback-safe defaults", () => {
    expect(validateEnvironment(validEnvironment())).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 56_789,
      CORS_ORIGINS: "http://127.0.0.1:5173",
      OPENAI_BASE_URL: "https://kldai.cc/v1",
      OUTBOX_DISPATCH_INTERVAL_MS: 1_000,
      OUTBOX_DISPATCH_BATCH_SIZE: 25,
      WORKER_REAPER_INTERVAL_MS: 5_000,
      WORKER_REAPER_BATCH_SIZE: 25,
      RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: false,
      OBJECT_STORAGE_ENABLED: false,
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      OBJECT_STORAGE_REGION: "us-east-1",
      OBJECT_STORAGE_BUCKET: "dnf-patch-artifacts",
      OBJECT_STORAGE_FORCE_PATH_STYLE: true,
      OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: 300,
      OBJECT_STORAGE_MAX_OBJECT_BYTES: 2_147_483_648,
      OBJECT_STORAGE_MAX_RUN_BYTES: 10_737_418_240,
      ARTIFACT_ORPHAN_REAPER_INTERVAL_MS: 30_000,
      ARTIFACT_ORPHAN_REAPER_BATCH_SIZE: 25,
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

  it("requires independent credentials when object storage is enabled", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        OBJECT_STORAGE_ENABLED: "true",
      }),
    ).toThrow();

    expect(
      validateEnvironment({
        ...validEnvironment(),
        OBJECT_STORAGE_ENABLED: "true",
        OBJECT_STORAGE_ACCESS_KEY: "dnf-patch-app",
        OBJECT_STORAGE_SECRET_KEY: "o".repeat(32),
      }).OBJECT_STORAGE_ENABLED,
    ).toBe(true);
  });

  it("rejects public object storage endpoints", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        OBJECT_STORAGE_ENABLED: "true",
        OBJECT_STORAGE_ENDPOINT: "https://storage.example.com",
        OBJECT_STORAGE_ACCESS_KEY: "dnf-patch-app",
        OBJECT_STORAGE_SECRET_KEY: "o".repeat(32),
      }),
    ).toThrow();
  });

  it("rejects an object storage secret reused as another service credential", () => {
    const workerToken = "w".repeat(32);
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        WORKER_SHARED_TOKEN: workerToken,
        OBJECT_STORAGE_ENABLED: "true",
        OBJECT_STORAGE_ACCESS_KEY: "dnf-patch-app",
        OBJECT_STORAGE_SECRET_KEY: workerToken,
      }),
    ).toThrow();
  });
});
