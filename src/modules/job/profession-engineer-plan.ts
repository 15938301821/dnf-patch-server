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
 * 输入输出：模型只选择四档 RGB、受限强度参数和可选视觉操作；输出固定携带几何、alpha 与安全
 * 策略。副作用：纯内存解析和对象构造。
 * 安全边界：模型不能提供路径、命令、代码、资源映射、运行时图片或部署状态；palette-map 与
 * alpha-preserve 永远启用，未知字段、重复操作和越界数值全部 fail-closed。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringifyJcsV1 } from "../../common/utils/canonical.js";

/** Engineer plan 私有 JSON 的独立内存/对象上限；不能被环境全局对象上限放宽。 */
export const maxProfessionEngineerPlanBytes = 16 * 1024;

const rgbByteSchema = z.number().int().min(0).max(255);
const rgbSchema = z.tuple([rgbByteSchema, rgbByteSchema, rgbByteSchema]);
const optionalOperationSchema = z.enum([
  "rim-light",
  "particle-trail",
  "spatial-crack",
  "blade-core",
]);
const enabledOperationSchema = z.enum([
  "palette-map",
  ...optionalOperationSchema.options,
  "alpha-preserve",
]);

const paletteSchema = z
  .object({
    shadow: rgbSchema,
    midtone: rgbSchema,
    rim: rgbSchema,
    core: rgbSchema,
  })
  .strict();

const parametersSchema = z
  .object({
    sourceColorMix: z.number().min(0).max(1),
    coreThreshold: z.number().min(0.5).max(0.95),
    coreIntensity: z.number().min(0).max(1),
    rimThreshold: z.number().min(0).max(0.8),
    rimIntensity: z.number().min(0).max(1),
    phaseAmount: z.number().min(0).max(1),
    crackDensity: z.number().min(0).max(0.25),
    crackIntensity: z.number().min(0).max(1),
  })
  .strict();

/** Engineer 模型唯一允许返回的结构；不含安全状态、来源身份、本机路径或任意代码。 */
export const professionEngineerModelDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    palette: paletteSchema,
    parameters: parametersSchema,
    optionalOperations: z.array(optionalOperationSchema).max(4),
  })
  .strict()
  .superRefine((decision, context) => {
    if (
      new Set(decision.optionalOperations).size !==
      decision.optionalOperations.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["optionalOperations"],
        message: "Engineer operations must be unique.",
      });
    }
  });

/** Server 正规化后可持久化并交给固定 Aseprite adapter 的版本化 style plan。 */
export const professionEngineerStylePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("dnf-aseprite-pixel-style-plan-v1"),
    geometryPolicy: z.literal("strict-preserve-source-frame-position-size"),
    alphaPolicy: z.literal("preserve-source-alpha-byte-exact"),
    palette: paletteSchema,
    parameters: parametersSchema,
    enabledOperations: z.array(enabledOperationSchema).min(2).max(6),
    safety: z
      .object({
        arbitraryCodeAccepted: z.literal(false),
        resourceFactsFromModel: z.literal(false),
        runtimeImageFromImageModel: z.literal(false),
        fullSkillCoverageProven: z.literal(false),
        deploymentAuthorized: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    const operations = new Set(plan.enabledOperations);
    if (
      operations.size !== plan.enabledOperations.length ||
      !operations.has("palette-map") ||
      !operations.has("alpha-preserve")
    ) {
      context.addIssue({
        code: "custom",
        path: ["enabledOperations"],
        message: "Style plan operations are incomplete or repeated.",
      });
    }
  });

export type ProfessionEngineerModelDecision = z.infer<
  typeof professionEngineerModelDecisionSchema
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
    schemaVersion: 1,
    kind: "dnf-aseprite-pixel-style-plan-v1",
    geometryPolicy: "strict-preserve-source-frame-position-size",
    alphaPolicy: "preserve-source-alpha-byte-exact",
    palette: decision.palette,
    parameters: decision.parameters,
    enabledOperations: [
      "palette-map",
      ...decision.optionalOperations,
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
