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
  normalizeProfessionEngineerModelDecision,
  parseProfessionEngineerStylePlanBytes,
  professionEngineerModelDecisionSchema,
  professionEngineerModelWireDecisionSchema,
  professionEngineerStylePlanSchema,
  type ProfessionEngineerModelDecision,
} from "../../../src/modules/job/profession-engineer-plan.js";

describe("Profession engineer style plan", () => {
  it("creates v5 creative stable frames while limiting official and reference authority", () => {
    const plan = createProfessionEngineerStylePlan(decision());

    expect(plan).toMatchObject({
      schemaVersion: 5,
      kind: "dnf-aseprite-creative-stable-frame-plan-v5",
      geometryPolicy: "strict-preserve-source-frame-structure",
      alphaPolicy: "preserve-source-alpha-byte-exact",
      rgbPolicy: "creative-visible-rgb-reconstruction",
      mapping: {
        referenceRole: "style-and-composition-only",
        sampling: "smoothed-style-field",
      },
      enabledOperations: [
        "reference-style-extraction",
        "visible-rgb-reconstruction",
        "isolated-noise-suppression",
        "continuous-energy-band",
        "clean-bright-core",
        "sharp-edge-finish",
        "dxt1-background-preserve",
        "alpha-preserve",
        "quality-gate",
      ],
      safety: {
        arbitraryCodeAccepted: false,
        resourceFactsFromModel: false,
        runtimeRgbFromImageModel: false,
        runtimeImageDirectReplacement: false,
        fullSkillCoverageProven: false,
        deploymentAuthorized: false,
      },
    });
    expect(plan.qualityPolicy).toMatchObject({
      maximumIsolatedNoiseRatio: 0.015,
      minimumContinuousBandRatio: 0.55,
      minimumBrightCoreRatio: 0.01,
      minimumEdgeContrast: 24,
      maximumStrongEdgeRatio: 0.25,
      maximumPeriodicStripeRatio: 0.08,
      maximumWhiteLineRatio: 0.45,
      maximumDxt1BoundaryJumpRatio: 0.05,
      nonPlaceholderFrameTransferRequired: true,
    });
    expect(plan).not.toHaveProperty("palette");
  });

  it("keeps historical v3 canonical plans readable without generating them", () => {
    const legacyPlan = {
      schemaVersion: 3,
      kind: "dnf-aseprite-reference-transfer-plan-v3",
      geometryPolicy: "strict-preserve-source-frame-position-size",
      alphaPolicy: "preserve-source-alpha-byte-exact",
      rgbPolicy: "image-model-reference-primary",
      mapping: {
        referenceBounds: decision().referenceBounds,
        atlasCoordinatePolicy: "proportional-source-cell-map",
        sampling: "alpha-weighted-bilinear-nearest-visible",
      },
      qualityPolicy: {
        minimumReferenceCoverage: 0.8,
        minimumReferenceSimilarity: 0.9,
        minimumEdgeEnergyRatio: 1.01,
        transparentRgbMustBeZero: true,
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
    };

    expect(professionEngineerStylePlanSchema.parse(legacyPlan)).toEqual(
      legacyPlan,
    );
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

  it("falls back narrow valid bounds to the full reference without accepting unsafe coordinates", () => {
    expect(
      normalizeProfessionEngineerModelDecision({
        ...decision(),
        referenceBounds: {
          ...decision().referenceBounds,
          right: decision().referenceBounds.left + 0.1,
        },
      }),
    ).toEqual({
      schemaVersion: 2,
      referenceBounds: { left: 0, top: 0, right: 1, bottom: 1 },
    });
    expect(() =>
      normalizeProfessionEngineerModelDecision({
        ...decision(),
        referenceBounds: { ...decision().referenceBounds, bottom: 1.1 },
      }),
    ).toThrow();
    expect(() =>
      normalizeProfessionEngineerModelDecision({
        ...decision(),
        referenceBounds: { ...decision().referenceBounds, right: 0.01 },
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
