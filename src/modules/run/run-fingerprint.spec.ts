import { describe, expect, it } from "vitest";
import { createRunSchema, type CreateRunInput } from "./run.contracts.js";
import { createRunRequestFingerprint } from "./run-fingerprint.js";

function runInput(): CreateRunInput {
  return createRunSchema.parse({
    projectId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    clientRunId: "client-run",
    action: "validate-only",
    requestSha256: "a".repeat(64),
    jobs: [
      {
        kind: "context-freeze",
        payload: {
          schemaVersion: 1,
          profileId: "profile-v2",
          parameters: { alpha: 1, beta: 2 },
        },
        maxAttempts: 2,
      },
    ],
    policyId: "policy-v2",
    policySha256: "b".repeat(64),
  });
}

describe("createRunRequestFingerprint", () => {
  it("规范化证据哈希大小写与 JSON 对象键顺序", () => {
    const first = runInput();
    const reordered = createRunSchema.parse({
      ...first,
      requestSha256: first.requestSha256.toUpperCase(),
      policySha256: first.policySha256.toUpperCase(),
      jobs: [
        {
          ...first.jobs[0],
          payload: {
            schemaVersion: 1,
            profileId: "profile-v2",
            parameters: { beta: 2, alpha: 1 },
          },
        },
      ],
    });
    expect(createRunRequestFingerprint(first)).toBe(
      createRunRequestFingerprint(reordered),
    );
  });

  it("请求语义变化时生成不同指纹", () => {
    const first = runInput();
    const changed = createRunSchema.parse({
      ...first,
      clientRunId: "different-client-run",
    });
    expect(createRunRequestFingerprint(first)).not.toBe(
      createRunRequestFingerprint(changed),
    );
  });

  it("不同 owner 不能复用同一个幂等指纹", () => {
    const input = runInput();
    expect(
      createRunRequestFingerprint(
        input,
        "11111111-1111-4111-8111-111111111111",
      ),
    ).not.toBe(
      createRunRequestFingerprint(
        input,
        "22222222-2222-4222-8222-222222222222",
      ),
    );
  });
});
