/**
 * @fileoverview 定义 Profession V6 四个输出 Artifact 的严格 provenance schema；不查询数据库、
 * 不读取 Artifact 正文，也不决定 passed 终态。
 * @module modules/job/profession-v6-output-evidence
 * @author AI生成
 * @created 2026-08-01
 * @relatedPlan N/A - 用户直接要求实现 Profession V6
 *
 * 调用关系：总 Profession provenance 联合导入这些 schema，Worker 上传与 Server 终态复核消费同形 JSON。
 * 输入输出：输入是未知 JSON，输出是严格 V6 判别结构。副作用：无。
 * 安全边界：V6 只绑定逐帧 target-set、manifest 和固定 Aseprite V6 身份；未知字段及安全声明漂移均拒绝。
 */
import { z } from "zod";

const sha256Schema = z.string().regex(/^[A-F0-9]{64}$/u);

const boundArtifactSchema = z
  .object({
    artifactId: z.uuid(),
    sha256: sha256Schema,
  })
  .strict();

const internalPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:/u.test(value) &&
      value === value.normalize("NFC").toLowerCase() &&
      !value
        .split("/")
        .some(
          (segment) =>
            segment.length === 0 || segment === "." || segment === "..",
        ),
    { message: "V6 预览帧必须使用规范化 NPK 内部路径。" },
  );

const comparisonFrameSchema = z
  .object({
    entryIndex: z.number().int().min(0).max(499),
    frameIndex: z.number().int().min(0).max(1_000_000),
    internalPath: internalPathSchema,
    width: z.number().int().positive().max(1_000_000),
    height: z.number().int().positive().max(1_000_000),
    canvasWidth: z.number().int().positive().max(1_000_000),
    canvasHeight: z.number().int().positive().max(1_000_000),
    x: z.number().int().min(-1_000_000).max(1_000_000),
    y: z.number().int().min(-1_000_000).max(1_000_000),
    decodedBgraSha256: sha256Schema,
  })
  .strict();

const targetPreviewFrameSchema = z
  .object({
    artifactId: z.uuid(),
    modelCallId: z.uuid(),
    imageAttemptId: z.uuid(),
    mediaType: z.literal("image/png"),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    sha256: sha256Schema,
    sourceAlphaSha256: sha256Schema,
    normalizationAlgorithm: z.literal(
      "centered-exact-aspect-lanczos3-source-alpha-v1",
    ),
  })
  .strict();

const targetFrameOutputEvidenceFields = {
  schemaVersion: z.literal(6),
  jobId: z.uuid(),
  attempt: z.number().int().min(1).max(10),
  skillId: z.uuid(),
  source: z
    .object({
      runId: z.uuid(),
      inventoryId: z.uuid(),
      sourceSha256: sha256Schema,
      frameManifestArtifactId: z.uuid(),
      frameManifestSha256: sha256Schema,
      frameManifestToolSha256: sha256Schema,
    })
    .strict(),
  targetFrameManifest: z
    .object({
      artifactId: z.uuid(),
      mediaType: z.literal("application/json"),
      byteLength: z
        .number()
        .int()
        .positive()
        .max(16 * 1024 * 1024),
      sha256: sha256Schema,
    })
    .strict(),
  targetSet: z
    .object({
      schemaVersion: z.literal(1),
      sha256: sha256Schema,
      targetFrameCount: z.number().int().min(1).max(2_048),
    })
    .strict(),
  aseprite: z
    .object({
      profileId: z.literal("aseprite-cli-v6"),
      binarySha256: sha256Schema,
      adapterSha256: sha256Schema,
    })
    .strict(),
  safety: z
    .object({
      targetFramesUsedAsRuntimeRgbSource: z.literal(true),
      sourceAlphaUsedAsRuntimeAlpha: z.literal(true),
      hiddenSourcePixelsPreserved: z.literal(true),
      linkFramesPreserved: z.literal(true),
      dxt1LowLightSourceRgbPreserved: z.literal(true),
      transparentRgbCleared: z.literal(true),
      sourceGeometryPreserved: z.literal(true),
      sourceAlphaPreserved: z.literal(true),
      deploymentAuthorized: z.literal(false),
      deploymentPerformed: z.literal(false),
      fullSkillCoverageProven: z.literal(false),
      clientCompatibilityProven: z.literal(false),
    })
    .strict(),
};

/** V6 projects ZIP 来源证据。 */
export const targetProjectsProvenanceSchema = z
  .object({
    ...targetFrameOutputEvidenceFields,
    kind: z.literal("profession-target-projects-v6"),
  })
  .strict();

/** V6 validation ZIP 来源证据，并绑定 projects 回执。 */
export const targetValidationProvenanceSchema = z
  .object({
    ...targetFrameOutputEvidenceFields,
    kind: z.literal("profession-target-validation-v6"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();

/** V6 源帧预览来源证据，并绑定集合内代表目标帧。 */
export const targetSourcePreviewProvenanceSchema = z
  .object({
    ...targetFrameOutputEvidenceFields,
    kind: z.literal("profession-target-source-frame-preview-v6"),
    frame: comparisonFrameSchema,
    targetFrame: targetPreviewFrameSchema,
    asepriteValidation: boundArtifactSchema,
  })
  .strict();

/** V6 结果预览来源证据，并绑定 validation 与源预览回执。 */
export const targetResultPreviewProvenanceSchema = z
  .object({
    ...targetFrameOutputEvidenceFields,
    kind: z.literal("profession-target-result-preview-v6"),
    frame: comparisonFrameSchema,
    targetFrame: targetPreviewFrameSchema,
    asepriteValidation: boundArtifactSchema,
    sourcePreview: boundArtifactSchema,
  })
  .strict();
