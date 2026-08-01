/**
 * @fileoverview 定义 Profession V6 单帧图片生成的 Worker DTO、脱敏结果和目标 Artifact 来源证据；
 * 不接受 Prompt、模型、endpoint、对象 key、路径或图片正文，也不执行数据库或模型调用。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：Worker 按 target manifest 的固定帧顺序提交当前 lease 与帧坐标；Controller 先用本文件
 * schema 校验，Service/Repository 再从已冻结 Job、source PNG 和用户模型配置恢复全部执行上下文。
 * 输出只告诉 Worker 当前帧仍在处理、已阻断，或已生成可短期授权下载的目标 Artifact 摘要。
 * 副作用：本文件只有内存校验。安全边界：帧坐标只是已 prepared 行的选择器，不能扩大技能范围；
 * Artifact provenance 的尺寸、Alpha、模型调用和四项 false 安全状态必须成组保存并在读取后重验。
 */
import { z } from "zod";
import { professionSkillLeaseSchema } from "./profession-execution.contracts.js";

const sha256Schema = z.string().regex(/^[A-F0-9]{64}$/u);
const frameIndexSchema = z.number().int().min(0).max(999_999);
const normalizationAlgorithm =
  "centered-exact-aspect-lanczos3-source-alpha-v1" as const;

/** Worker 只能选择当前技能中已冻结的帧，不能提交任何生成参数。 */
export const generateProfessionTargetFrameSchema = professionSkillLeaseSchema
  .extend({
    entryIndex: frameIndexSchema,
    frameIndex: frameIndexSchema,
  })
  .strict();

const professionTargetFrameIdentityViewFields = {
  schemaVersion: z.literal(1),
  skillId: z.uuid(),
  entryIndex: frameIndexSchema,
  frameIndex: frameIndexSchema,
} as const;

/** Worker 轮询单帧生成时消费的有限状态；passed 才能进入受控 Artifact 下载。 */
export const professionTargetFrameGenerationViewSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        ...professionTargetFrameIdentityViewFields,
        status: z.literal("in-progress"),
      })
      .strict(),
    z
      .object({
        ...professionTargetFrameIdentityViewFields,
        status: z.literal("blocked"),
        errorCode: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Z0-9_]+$/u),
      })
      .strict(),
    z
      .object({
        ...professionTargetFrameIdentityViewFields,
        status: z.literal("passed"),
        modelCallId: z.uuid(),
        imageAttemptId: z.uuid(),
        targetArtifactId: z.uuid(),
        mediaType: z.literal("image/png"),
        width: z.number().int().positive().max(1_000_000),
        height: z.number().int().positive().max(1_000_000),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024),
        sha256: sha256Schema,
        sourceAlphaSha256: sha256Schema,
        normalizationAlgorithm: z.literal(normalizationAlgorithm),
      })
      .strict(),
  ],
);

/** Server 生成目标 PNG Artifact 时保存的完整来源；图片正文仍只在私有对象存储。 */
export const professionTargetFrameOutputProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("profession-target-frame-output-v1"),
    jobId: z.uuid(),
    runId: z.uuid(),
    attempt: z.number().int().min(1).max(1_000_000),
    skillId: z.uuid(),
    entryIndex: frameIndexSchema,
    frameIndex: frameIndexSchema,
    sourceArtifactId: z.uuid(),
    sourceSha256: sha256Schema,
    sourceAlphaSha256: sha256Schema,
    width: z.number().int().positive().max(1_000_000),
    height: z.number().int().positive().max(1_000_000),
    modelCallId: z.uuid(),
    imageAttemptId: z.uuid(),
    generationConfigSha256: sha256Schema,
    normalizationAlgorithm: z.literal(normalizationAlgorithm),
    safety: z
      .object({
        sourceGeometryPreserved: z.literal(true),
        sourceAlphaPreserved: z.literal(true),
        targetDimensionsEqualSource: z.literal(true),
        directRuntimeUseAllowed: z.literal(false),
        deploymentAuthorized: z.literal(false),
        deploymentPerformed: z.literal(false),
        fullSkillCoverageProven: z.literal(false),
        clientCompatibilityProven: z.literal(false),
      })
      .strict(),
  })
  .strict();

/** Controller 解析后的当前 lease 与帧选择器。 */
export type GenerateProfessionTargetFrameInput = z.infer<
  typeof generateProfessionTargetFrameSchema
>;

/** Worker 可依赖的单帧生成状态；不含对象 key、Prompt 或模型配置。 */
export type ProfessionTargetFrameGenerationView = z.infer<
  typeof professionTargetFrameGenerationViewSchema
>;

/** 目标 PNG Artifact 在写入与读取时必须通过的有界 provenance。 */
export type ProfessionTargetFrameOutputProvenance = z.infer<
  typeof professionTargetFrameOutputProvenanceSchema
>;

/** 当前固定正规化算法；数据库 CHECK、Artifact 与 Worker响应必须保持一致。 */
export const professionTargetFrameNormalizationAlgorithm =
  normalizationAlgorithm;
