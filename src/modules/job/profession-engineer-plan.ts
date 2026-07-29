/**
 * @fileoverview 定义 Profession 单技能 Engineer 模型可返回的受限视觉决策，以及由 Server
 * 注入不可变安全策略后的 Aseprite style plan；不查询数据库、不调用模型或本机工具。
 * @module modules/job/profession-engineer-plan
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：ProfessionExecutionService 把冻结技能上下文交给 engineer 结构化模型，并用本文件
 * 校验、正规化输出；后续 Worker 只能消费正规化 plan，不能消费模型自由文本。
 * 输入输出：模型只标注生成图中与官方图集对应的归一化内容边界；输出固定携带 RGB 来源、采样、
 * 几何、alpha 与质量策略。副作用：纯内存解析和对象构造。
 * 安全边界：模型不能提供路径、命令、代码、资源映射、像素正文或部署状态；逐帧身份仍由 Worker
 * 已核验的官方帧映射决定，未知字段、越界边界和过小内容区域全部 fail-closed。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringifyJcsV1 } from "../../common/utils/canonical.js";

/** Engineer plan 私有 JSON 的独立内存/对象上限；不能被环境全局对象上限放宽。 */
export const maxProfessionEngineerPlanBytes = 16 * 1024;

const referenceBoundsWireSchema = z
  .object({
    left: z.number(),
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
  })
  .strict();

const referenceBoundsSchema = referenceBoundsWireSchema.superRefine(
  (bounds, context) => {
    for (const [key, value] of Object.entries(bounds)) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Reference bounds must be finite normalized coordinates.",
        });
      }
    }
    if (bounds.right - bounds.left < 0.5) {
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: "Reference content width is too small.",
      });
    }
    if (bounds.bottom - bounds.top < 0.5) {
      context.addIssue({
        code: "custom",
        path: ["bottom"],
        message: "Reference content height is too small.",
      });
    }
  },
);

/**
 * Provider wire schema 只表达结构化输出接口普遍支持的基础约束。tuple 长度、数值边界、
 * 操作数量与唯一性仍由下方严格领域 schema 在任何持久化或 Artist 调用前二次校验。
 */
export const professionEngineerModelWireDecisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    referenceBounds: referenceBoundsWireSchema,
  })
  .strict();

/** Engineer 模型唯一允许返回的结构；不含安全状态、来源身份、本机路径或任意代码。 */
export const professionEngineerModelDecisionSchema = z
  .object({
    schemaVersion: z.literal(2),
    referenceBounds: referenceBoundsSchema,
  })
  .strict();

/** Server 正规化后可持久化并交给固定 Aseprite adapter 的 v3 style plan。 */
export const professionEngineerStylePlanSchema = z
  .object({
    schemaVersion: z.literal(3),
    kind: z.literal("dnf-aseprite-reference-transfer-plan-v3"),
    geometryPolicy: z.literal("strict-preserve-source-frame-position-size"),
    alphaPolicy: z.literal("preserve-source-alpha-byte-exact"),
    rgbPolicy: z.literal("image-model-reference-primary"),
    mapping: z
      .object({
        referenceBounds: referenceBoundsSchema,
        atlasCoordinatePolicy: z.literal("proportional-source-cell-map"),
        sampling: z.literal("alpha-weighted-bilinear-nearest-visible"),
      })
      .strict(),
    qualityPolicy: z
      .object({
        minimumReferenceCoverage: z.literal(0.8),
        minimumReferenceSimilarity: z.literal(0.9),
        minimumEdgeEnergyRatio: z.literal(1.01),
        transparentRgbMustBeZero: z.literal(true),
      })
      .strict(),
    enabledOperations: z.tuple([
      z.literal("reference-rgb-transfer"),
      z.literal("source-effect-mask"),
      z.literal("detail-sharpen"),
      z.literal("alpha-preserve"),
      z.literal("quality-gate"),
    ]),
    safety: z
      .object({
        arbitraryCodeAccepted: z.literal(false),
        resourceFactsFromModel: z.literal(false),
        runtimeRgbFromImageModel: z.literal(true),
        runtimeImageDirectReplacement: z.literal(false),
        fullSkillCoverageProven: z.literal(false),
        deploymentAuthorized: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type ProfessionEngineerModelDecision = z.infer<
  typeof professionEngineerModelDecisionSchema
>;
export type ProfessionEngineerModelWireDecision = z.infer<
  typeof professionEngineerModelWireDecisionSchema
>;
export type ProfessionEngineerStylePlan = z.infer<
  typeof professionEngineerStylePlanSchema
>;

/** 可写入私有对象存储的 canonical plan 字节和摘要，不包含对象 key 或数据库标识。 */
export interface EncodedProfessionEngineerStylePlan {
  plan: ProfessionEngineerStylePlan;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
}

/**
 * 把模型决策收束为固定安全计划；模型无权关闭必选操作或提升任何证明状态。
 * @param input OpenAI structured adapter 已解析的候选决策；本函数仍重新解析以保护其他调用方。
 * @returns 可按 JCS 序列化、持久化并由后续固定 adapter 再次 schema 校验的 plan。
 */
export function createProfessionEngineerStylePlan(
  input: ProfessionEngineerModelDecision,
): ProfessionEngineerStylePlan {
  const decision = professionEngineerModelDecisionSchema.parse(input);
  return professionEngineerStylePlanSchema.parse({
    schemaVersion: 3,
    kind: "dnf-aseprite-reference-transfer-plan-v3",
    geometryPolicy: "strict-preserve-source-frame-position-size",
    alphaPolicy: "preserve-source-alpha-byte-exact",
    rgbPolicy: "image-model-reference-primary",
    mapping: {
      referenceBounds: decision.referenceBounds,
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
  });
}

/**
 * 把已正规化计划编码为唯一 JCS UTF-8 表示，供 Artifact、模型 Prompt 和恢复共同绑定。
 * @param input 已由 Server 注入固定安全字段的候选计划；本函数仍重新执行严格 schema 校验。
 * @returns 不超过 16 KiB 的完整字节、长度和大写 SHA-256。
 * @throws ZodError 或 RangeError 当结构漂移或编码超出固定预算时抛出，调用方必须 fail-closed。
 */
export function encodeProfessionEngineerStylePlan(
  input: ProfessionEngineerStylePlan,
): EncodedProfessionEngineerStylePlan {
  const plan = professionEngineerStylePlanSchema.parse(input);
  const bytes = Buffer.from(stableStringifyJcsV1(plan), "utf8");
  if (bytes.byteLength > maxProfessionEngineerPlanBytes) {
    throw new RangeError("PROFESSION_ENGINEER_PLAN_TOO_LARGE");
  }
  return {
    plan,
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
  };
}

/**
 * 从对象存储完整回读的字节恢复严格 style plan；不接受替换字符、尾随文本或未知字段。
 * @param bytes 已由 ObjectStoragePort 复核长度和 SHA 的候选正文；仍不信任其 JSON 语义。
 * @returns 通过当前版本 schema 的 plan，可安全绑定到 Artist Prompt。
 * @throws TypeError、SyntaxError 或 ZodError 当 UTF-8、JSON 或领域结构非法时抛出。
 */
export function parseProfessionEngineerStylePlanBytes(
  bytes: Uint8Array,
): ProfessionEngineerStylePlan {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maxProfessionEngineerPlanBytes
  ) {
    throw new RangeError("PROFESSION_ENGINEER_PLAN_BYTE_LENGTH_INVALID");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return professionEngineerStylePlanSchema.parse(JSON.parse(text) as unknown);
}
