import { describe, expect, it } from "vitest";
import { resolveOpenAiEndpoint } from "./openai-endpoint.js";

describe("resolveOpenAiEndpoint", () => {
  it("returns a redacted compatible identity", () => {
    expect(resolveOpenAiEndpoint("https://gateway.example/v1/")).toEqual({
      baseUrl: "https://gateway.example/v1",
      identity: "gateway.example/v1",
      custom: true,
    });
  });

  it.each([
    "http://gateway.example/v1",
    "https://user:secret@gateway.example/v1",
    "https://gateway.example/api",
    "https://gateway.example/v1?token=secret",
  ])("rejects unsafe endpoint %s", (value) => {
    expect(() => resolveOpenAiEndpoint(value)).toThrow();
  });
});
