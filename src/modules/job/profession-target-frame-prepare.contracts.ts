/**
 * @fileoverview 定义 Profession V6 target-frame manifest prepare 的 Worker DTO、Artifact provenance
 * 与脱敏回执；不读取对象正文、不执行数据库事务，也不调用图片模型或本机工具。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：Worker 先通过通用 Artifact 上传协议提交 JCS manifest，再调用内部 prepare Controller；
 * Controller 用本文件 schema 校验 body，Service/Repository 继续验证 exact lease、finalized upload、
 * source Artifact 正文和逐帧结构。输出只返回计数和 manifest ID，不暴露对象 key、Prompt 或模型配置。
 * 副作用：本文件只有运行时校验。安全边界：请求不能选择路径、stage、Provider、模型、Prompt 或工具；
 * provenance 必须绑定当前 Job payload、attempt、skill 和官方来源，四项安全结论不能在此提升。
 */
import { z } from "zod";
import { professionSkillLeaseSchema } from "./profession-execution.contracts.js";
import { professionTargetFrameManifestMaxBytes } from "./profession-target-frame-manifest.js";

const sha256Schema = z.string().regex(/^[A-F0-9]{64}$/u);

/** Worker 请求 prepare 时可提交的全部字段；Artifact 正文和 storage key 不能直接进入 DTO。 */
export const prepareProfessionTargetFramesSchema = professionSkillLeaseSchema
  .extend({
    manifestArtifactId: z.uuid(),
    manifestMediaType: z.literal("application/json"),
    manifestByteLength: z
      .number()
      .int()
      .positive()
      .max(professionTargetFrameManifestMaxBytes),
    manifestSha256: sha256Schema,
  })
  .strict();

/**
 * target manifest 上传会话和 Artifact 必须共享的严格 provenance。
 * `frameCount` 包含生成、Hidden 和 LINK 全部行，供正文读取前的完整幂等检查；其余两项只统计
 * `generate-same-size`，不能把 Hidden/LINK 计入模型预算。
 */
export const professionTargetFrameManifestProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("profession-target-frame-manifest-v1"),
    jobId: z.uuid(),
    runId: z.uuid(),
    jobPayloadSha256: sha256Schema,
    attempt: z.number().int().min(1).max(10),
    skillId: z.uuid(),
    sourceRunId: z.uuid(),
    sourceInventoryId: z.uuid(),
    sourceFrameManifestArtifactId: z.uuid(),
    sourceFrameManifestSha256: sha256Schema,
    sourceSha256: sha256Schema,
    frameCount: z.number().int().positive().max(100_000),
    targetFrameCount: z.number().int().min(1).max(2_048),
    targetPixelCount: z.number().int().min(1).max(134_217_728),
    deploymentAuthorized: z.literal(false),
  })
  .strict();

/** prepare 成功或同一 manifest 幂等重报时返回的有限证据；不代表模型 target 已生成。 */
export const professionTargetFramePreparationViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("prepared"),
    skillId: z.uuid(),
    manifestArtifactId: z.uuid(),
    frameCount: z.number().int().positive().max(100_000),
    targetFrameCount: z.number().int().min(1).max(2_048),
    targetPixelCount: z.number().int().min(1).max(134_217_728),
  })
  .strict();

/** Worker 为单个 `generate-same-size` target 登记 finalized 官方 PNG 时提交的严格声明。 */
export const registerProfessionTargetFrameSourceSchema =
  professionSkillLeaseSchema
    .extend({
      skillId: z.uuid(),
      entryIndex: z.number().int().min(0).max(999_999),
      frameIndex: z.number().int().min(0).max(999_999),
      sourceArtifactId: z.uuid(),
      sourceMediaType: z.literal("image/png"),
      sourceByteLength: z
        .number()
        .int()
        .positive()
        .max(64 * 1024 * 1024),
      sourceSha256: sha256Schema,
    })
    .strict();

/**
 * 官方逐帧 PNG 上传会话与 Artifact 共用的 provenance。
 * 几何和两个源摘要必须与已 prepared target 行完全一致；PNG 只是模型输入载体，不能改变官方事实。
 */
export const professionTargetFrameSourceProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("profession-target-frame-source-v1"),
    jobId: z.uuid(),
    runId: z.uuid(),
    jobPayloadSha256: sha256Schema,
    attempt: z.number().int().min(1).max(10),
    skillId: z.uuid(),
    entryIndex: z.number().int().min(0).max(999_999),
    frameIndex: z.number().int().min(0).max(999_999),
    width: z.number().int().positive().max(1_000_000),
    height: z.number().int().positive().max(1_000_000),
    sourceDecodedBgraSha256: sha256Schema,
    sourceAlphaSha256: sha256Schema,
    targetPolicy: z.literal("generate-same-size"),
    deploymentAuthorized: z.literal(false),
  })
  .strict();

/** 单帧官方 PNG 首次登记或同证据幂等重报后的脱敏回执。 */
export const professionTargetFrameSourceViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("registered"),
    skillId: z.uuid(),
    entryIndex: z.number().int().min(0).max(999_999),
    frameIndex: z.number().int().min(0).max(999_999),
    sourceArtifactId: z.uuid(),
    sourceByteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    sourceSha256: sha256Schema,
  })
  .strict();

/** Controller 解析后的 exact lease 与 target manifest Artifact 声明。 */
export type PrepareProfessionTargetFramesInput = z.infer<
  typeof prepareProfessionTargetFramesSchema
>;

/** Worker 可依赖的幂等 prepare 回执；不含逐帧数据库 ID 或对象存储位置。 */
export type ProfessionTargetFramePreparationView = z.infer<
  typeof professionTargetFramePreparationViewSchema
>;

/** Repository 从数据库 JSON 再次解析后使用的 manifest provenance。 */
export type ProfessionTargetFrameManifestProvenance = z.infer<
  typeof professionTargetFrameManifestProvenanceSchema
>;

/** Controller 解析后的单帧官方 PNG finalized Artifact 声明。 */
export type RegisterProfessionTargetFrameSourceInput = z.infer<
  typeof registerProfessionTargetFrameSourceSchema
>;

/** Artifact 授权、finalize 与登记事务必须共享的官方帧 PNG provenance。 */
export type ProfessionTargetFrameSourceProvenance = z.infer<
  typeof professionTargetFrameSourceProvenanceSchema
>;

/** Worker 可依赖的单帧输入冻结回执；不含对象 key 或模型配置。 */
export type ProfessionTargetFrameSourceView = z.infer<
  typeof professionTargetFrameSourceViewSchema
>;
