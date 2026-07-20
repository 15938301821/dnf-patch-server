import { describe, expect, it } from "vitest";
import { environmentSchema } from "./config/environment.js";

describe("application safety defaults", () => {
  it("keeps model egress unavailable without an API key", () => {
    const parsed = environmentSchema.safeParse({
      DATABASE_URL: "mysql://runtime-user@127.0.0.1:3306/dnf_patch",
      CLIENT_SHARED_TOKEN: "c".repeat(32),
      WORKER_SHARED_TOKEN: "w".repeat(32),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.OPENAI_API_KEY).toBeUndefined();
      expect(parsed.data.HOST).toBe("127.0.0.1");
    }
  });
});
