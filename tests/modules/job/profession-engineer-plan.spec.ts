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
  professionEngineerModelWireDecisionSchema,
  professionEngineerStylePlanSchema,
  type ProfessionEngineerModelDecision,
} from "../../../src/modules/job/profession-engineer-plan.js";

describe("Profession engineer style plan", () => {
  it("makes the image-model reference the runtime RGB source while preserving geometry and alpha", () => {
    const plan = createProfessionEngineerStylePlan(decision());

    expect(plan).toMatchObject({
      schemaVersion: 3,
      kind: "dnf-aseprite-reference-transfer-plan-v3",
      geometryPolicy: "strict-preserve-source-frame-position-size",
      alphaPolicy: "preserve-source-alpha-byte-exact",
      rgbPolicy: "image-model-reference-primary",
      mapping: {
        sampling: "alpha-weighted-bilinear-nearest-visible",
      },
      enabledOperations: [
        "reference-rgb-transfer",
        "source-effect-mask",
        "detail-sharpen",
        "alpha-preserve",
        "quality-gate",
      ],
      safety: {
        arbitraryCodeAccepted: false,
        resourceFactsFromModel: false,
        runtimeRgbFromImageModel: true,
        runtimeImageDirectReplacement: false,
        fullSkillCoverageProven: false,
        deploymentAuthorized: false,
      },
    });
    expect(plan).not.toHaveProperty("palette");
  });

  it("rejects unknown fields, out-of-range bounds and undersized mappings", () => {
    expect(() =>
      professionEngineerModelDecisionSchema.parse({
        ...decision(),
        referenceBounds: { ...decision().referenceBounds, left: -0.01 },
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
        referenceBounds: {
          ...decision().referenceBounds,
          right: decision().referenceBounds.left + 0.2,
        },
      }),
    ).toThrow();
  });

  it("keeps provider wire constraints compatible and enforces strict domain constraints afterwards", () => {
    const wireDecision = professionEngineerModelWireDecisionSchema.parse({
      ...decision(),
      referenceBounds: { ...decision().referenceBounds, bottom: 1.1 },
    });

    expect(() =>
      professionEngineerModelDecisionSchema.parse(wireDecision),
    ).toThrow();
    expect(() =>
      professionEngineerModelWireDecisionSchema.parse({
        ...wireDecision,
        command: "do-not-accept",
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
    schemaVersion: 2,
    referenceBounds: {
      left: 0.03,
      top: 0.02,
      right: 0.97,
      bottom: 0.98,
    },
  };
}
