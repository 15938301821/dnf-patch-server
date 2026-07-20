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
      OPENAI_BASE_URL: "https://api.openai.com/v1",
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
});
