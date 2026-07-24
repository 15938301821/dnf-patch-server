/**
 * @fileoverview 验证 Engineer 模型输出只能正规化为固定安全 style plan；不调用模型、数据库、
 * 对象存储或 Aseprite，也不证明输出视觉质量和客户端兼容。
 * @module modules/job/profession-engineer-plan-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 */
import { describe, expect, it } from "vitest";
import {
  createProfessionEngineerStylePlan,
  encodeProfessionEngineerStylePlan,
  parseProfessionEngineerStylePlanBytes,
  professionEngineerModelDecisionSchema,
  professionEngineerStylePlanSchema,
  type ProfessionEngineerModelDecision,
} from "./profession-engineer-plan.js";

describe("Profession engineer style plan", () => {
  it("injects required operations and immutable safety policies", () => {
    const plan = createProfessionEngineerStylePlan(decision());

    expect(plan).toMatchObject({
      kind: "dnf-aseprite-pixel-style-plan-v1",
      geometryPolicy: "strict-preserve-source-frame-position-size",
      alphaPolicy: "preserve-source-alpha-byte-exact",
      enabledOperations: [
        "palette-map",
        "rim-light",
        "blade-core",
        "alpha-preserve",
      ],
      safety: {
        arbitraryCodeAccepted: false,
        resourceFactsFromModel: false,
        runtimeImageFromImageModel: false,
        fullSkillCoverageProven: false,
        deploymentAuthorized: false,
      },
    });
  });

  it("rejects duplicate operations, unknown fields and unsafe numeric ranges", () => {
    expect(() =>
      professionEngineerModelDecisionSchema.parse({
        ...decision(),
        optionalOperations: ["rim-light", "rim-light"],
      }),
    ).toThrow();
    expect(() =>
      professionEngineerModelDecisionSchema.parse({
        ...decision(),
        command: "do-not-accept",
      }),
    ).toThrow();
    expect(() =>
      professionEngineerModelDecisionSchema.parse({
        ...decision(),
        parameters: { ...decision().parameters, crackDensity: 0.5 },
      }),
    ).toThrow();
  });

  it("rejects a persisted plan that weakens fixed safety fields", () => {
    const plan = createProfessionEngineerStylePlan(decision());
    expect(() =>
      professionEngineerStylePlanSchema.parse({
        ...plan,
        safety: { ...plan.safety, deploymentAuthorized: true },
      }),
    ).toThrow();
  });

  it("round-trips one canonical UTF-8 plan with stable evidence", () => {
    const plan = createProfessionEngineerStylePlan(decision());
    const encoded = encodeProfessionEngineerStylePlan(plan);

    expect(parseProfessionEngineerStylePlanBytes(encoded.bytes)).toEqual(plan);
    expect(encoded.byteLength).toBe(encoded.bytes.byteLength);
    expect(encoded.sha256).toMatch(/^[A-F0-9]{64}$/u);
  });

  it("rejects invalid UTF-8 and schema-drifting stored JSON", () => {
    expect(() =>
      parseProfessionEngineerStylePlanBytes(Uint8Array.from([0xc3, 0x28])),
    ).toThrow();
    expect(() =>
      parseProfessionEngineerStylePlanBytes(
        Buffer.from('{"schemaVersion":1,"command":"forbidden"}', "utf8"),
      ),
    ).toThrow();
  });
});

function decision(): ProfessionEngineerModelDecision {
  return {
    schemaVersion: 1 as const,
    palette: {
      shadow: [10, 22, 51] as [number, number, number],
      midtone: [26, 143, 255] as [number, number, number],
      rim: [0, 212, 255] as [number, number, number],
      core: [255, 255, 255] as [number, number, number],
    },
    parameters: {
      sourceColorMix: 0.2,
      coreThreshold: 0.72,
      coreIntensity: 0.9,
      rimThreshold: 0.18,
      rimIntensity: 0.8,
      phaseAmount: 0.35,
      crackDensity: 0.04,
      crackIntensity: 0.55,
    },
    optionalOperations: ["rim-light", "blade-core"],
  };
}
