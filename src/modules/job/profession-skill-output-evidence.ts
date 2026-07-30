/**
 * @fileoverview 定义 Profession Worker 四个固定输出角色的严格 provenance；不读取对象正文、
 * 不查询数据库，也不把 Aseprite 产物扩大解释为 NPK、客户端兼容或部署证据。
 * @module modules/job/profession-skill-output-evidence
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：Worker 在申请 Artifact 上传时生产同形 JSON，PatchTask 接收事务从 upload session 和
 * Artifact 两侧重新解析；输入是未知数据库 JSON，输出是受限判别联合。副作用：仅内存校验。
 * 安全边界：角色、Job attempt、冻结源、Engineer/Artist Artifact、固定 Aseprite 双哈希和五项
 * false 声明必须同时匹配 Server 事实；未知字段不能被静默接受。
 */
import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

const uppercaseSha256Schema = sha256Schema.regex(/^[A-F0-9]{64}$/u);

const boundArtifactSchema = z
  .object({
    artifactId: z.uuid(),
    sha256: uppercaseSha256Schema,
  })
  .strict();

const npkInternalPathSchema = z
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
    { message: "预览帧必须使用规范化 NPK 内部路径。" },
  );

const comparisonFrameSchema = z
  .object({
    entryIndex: z.number().int().min(0).max(499),
    frameIndex: z.number().int().min(0).max(1_000_000),
    internalPath: npkInternalPathSchema,
    width: z.number().int().positive().max(1_000_000),
    height: z.number().int().positive().max(1_000_000),
    canvasWidth: z.number().int().positive().max(1_000_000),
    canvasHeight: z.number().int().positive().max(1_000_000),
    x: z.number().int().min(-1_000_000).max(1_000_000),
    y: z.number().int().min(-1_000_000).max(1_000_000),
    decodedBgraSha256: uppercaseSha256Schema,
  })
  .strict();

/** 历史参考传输质量 V1；只供既有 reference V2 Artifact 读取，不能作为当前生产质量。 */
const referenceTransferQualitySchema = z
  .object({
    schemaVersion: z.literal(1),
    evaluatedFrameCount: z.number().int().positive().max(100_000),
    evaluatedPixelCount: z.number().int().positive().max(1_000_000_000),
    referenceCoverage: z.number().min(0.8).max(1),
    referenceSimilarity: z.number().min(0.9).max(1),
    sourceEdgeEnergy: z.number().min(0).max(255),
    runtimeEdgeEnergy: z.number().min(0).max(255),
    edgeEnergyRatio: z.number().min(1.01).max(999),
  })
  .strict();

/** 历史稳定帧质量 V2；只与 creative V3 Artifact 绑定，不能进入新 passed 或 Package。 */
const historicalStableFrameQualitySchema = z
  .object({
    schemaVersion: z.literal(2),
    evaluatedFrameCount: z.number().int().positive().max(100_000),
    evaluatedPixelCount: z.number().int().positive().max(1_000_000_000),
    isolatedNoiseRatio: z.number().min(0).max(0.015),
    continuousBandRatio: z.number().min(0.55).max(1),
    brightCoreRatio: z.number().min(0.01).max(1),
    edgeContrast: z.number().min(24).max(255),
  })
  .strict();

/** 历史稳定帧质量 V3；只读既有 V4 Artifact，不能进入新 passed 或 Package。 */
const historicalStableFrameQualityV3Schema =
  historicalStableFrameQualitySchema.extend({
    schemaVersion: z.literal(3),
    strongEdgeRatio: z.number().min(0).max(0.25),
    periodicStripeRatio: z.number().min(0).max(0.08),
  });

/** 当前稳定帧质量 V4；新增指标取单帧最坏值，防止跨帧聚合稀释灾难帧。 */
const currentStableFrameQualitySchema =
  historicalStableFrameQualityV3Schema.extend({
    schemaVersion: z.literal(4),
    maximumWhiteLineRatio: z.number().min(0).max(0.45),
    maximumDxt1BoundaryJumpRatio: z.number().min(0).max(0.05),
  });
const readableStableFrameQualitySchema = z.discriminatedUnion("schemaVersion", [
  historicalStableFrameQualityV3Schema,
  currentStableFrameQualitySchema,
]);

const outputEvidenceIdentityFields = {
  jobId: z.uuid(),
  attempt: z.number().int().min(1).max(10),
  skillId: z.uuid(),
  source: z
    .object({
      runId: z.uuid(),
      inventoryId: z.uuid(),
      sourceSha256: uppercaseSha256Schema,
      frameManifestArtifactId: z.uuid(),
      frameManifestSha256: uppercaseSha256Schema,
      frameManifestToolSha256: uppercaseSha256Schema,
    })
    .strict(),
  engineerPlan: boundArtifactSchema,
  referenceImage: boundArtifactSchema.extend({ imageAttemptId: z.uuid() }),
  aseprite: z
    .object({
      profileId: z.literal("aseprite-cli"),
      binarySha256: uppercaseSha256Schema,
      adapterSha256: uppercaseSha256Schema,
    })
    .strict(),
};

const historicalReferenceOutputEvidenceFields = {
  schemaVersion: z.literal(2),
  ...outputEvidenceIdentityFields,
  referenceTransferQuality: referenceTransferQualitySchema,
  safety: z
    .object({
      referenceImageUsedAsRuntimeRgbSource: z.literal(true),
      referenceImageDirectPixelReplacement: z.literal(false),
      referenceTransferQualityPassed: z.literal(true),
      sourceGeometryPreserved: z.literal(true),
      sourceAlphaPreserved: z.literal(true),
      deploymentAuthorized: z.literal(false),
      deploymentPerformed: z.literal(false),
      fullSkillCoverageProven: z.literal(false),
      clientCompatibilityProven: z.literal(false),
    })
    .strict(),
};

const historicalCreativeOutputEvidenceFields = {
  schemaVersion: z.literal(3),
  ...outputEvidenceIdentityFields,
  referenceTransferQuality: historicalStableFrameQualitySchema,
  safety: z
    .object({
      referenceImageUsedAsRuntimeRgbSource: z.literal(false),
      referenceImageUsedAsStyleAndComposition: z.literal(true),
      creativeVisibleRgbReconstruction: z.literal(true),
      referenceImageDirectPixelReplacement: z.literal(false),
      referenceTransferQualityPassed: z.literal(true),
      sourceGeometryPreserved: z.literal(true),
      sourceAlphaPreserved: z.literal(true),
      deploymentAuthorized: z.literal(false),
      deploymentPerformed: z.literal(false),
      fullSkillCoverageProven: z.literal(false),
      clientCompatibilityProven: z.literal(false),
    })
    .strict(),
};

const currentCreativeOutputEvidenceFields = {
  ...historicalCreativeOutputEvidenceFields,
  schemaVersion: z.literal(4),
  referenceTransferQuality: currentStableFrameQualitySchema,
};

const readableCurrentCreativeOutputEvidenceFields = {
  ...currentCreativeOutputEvidenceFields,
  referenceTransferQuality: readableStableFrameQualitySchema,
};

const currentCreativeProjectsProvenanceSchema = z
  .object({
    ...currentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-projects-v4"),
  })
  .strict();

const currentCreativeValidationProvenanceSchema = z
  .object({
    ...currentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-validation-v4"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();

const currentCreativeSourcePreviewProvenanceSchema = z
  .object({
    ...currentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-source-frame-preview-v4"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
  })
  .strict();

const currentCreativeResultPreviewProvenanceSchema = z
  .object({
    ...currentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-result-preview-v4"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
    sourcePreview: boundArtifactSchema,
  })
  .strict();

const readableCurrentCreativeProjectsProvenanceSchema = z
  .object({
    ...readableCurrentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-projects-v4"),
  })
  .strict();
const readableCurrentCreativeValidationProvenanceSchema = z
  .object({
    ...readableCurrentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-validation-v4"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();
const readableCurrentCreativeSourcePreviewProvenanceSchema = z
  .object({
    ...readableCurrentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-source-frame-preview-v4"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
  })
  .strict();
const readableCurrentCreativeResultPreviewProvenanceSchema = z
  .object({
    ...readableCurrentCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-result-preview-v4"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
    sourcePreview: boundArtifactSchema,
  })
  .strict();

/** 当前生产入口专用联合；调用方不能借历史读取联合放宽 V4 kind 与 quality V3 的绑定。 */
export const currentProfessionSkillOutputProvenanceSchema =
  z.discriminatedUnion("kind", [
    currentCreativeProjectsProvenanceSchema,
    currentCreativeValidationProvenanceSchema,
    currentCreativeSourcePreviewProvenanceSchema,
    currentCreativeResultPreviewProvenanceSchema,
  ]);

/** 当前 Worker 可生产、passed 接收事务与 Package context 可消费的 V4 来源元数据。 */
export type CurrentProfessionSkillOutputProvenance = z.infer<
  typeof currentProfessionSkillOutputProvenanceSchema
>;

const historicalCreativeProjectsProvenanceSchema = z
  .object({
    ...historicalCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-projects-v3"),
  })
  .strict();

const historicalCreativeValidationProvenanceSchema = z
  .object({
    ...historicalCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-validation-v3"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();

const historicalCreativeSourcePreviewProvenanceSchema = z
  .object({
    ...historicalCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-source-frame-preview-v3"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
  })
  .strict();

const historicalCreativeResultPreviewProvenanceSchema = z
  .object({
    ...historicalCreativeOutputEvidenceFields,
    kind: z.literal("profession-creative-result-preview-v3"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
    sourcePreview: boundArtifactSchema,
  })
  .strict();

/** 历史 V1 只允许详情读取；当前接收事务和 Package 必须显式要求 V2 kind。 */
const legacyOutputEvidenceFields = {
  schemaVersion: z.literal(1),
  ...outputEvidenceIdentityFields,
  safety: z
    .object({
      referenceImageUsedAsVisualGuidance: z.literal(true),
      referenceImageDirectPixelReplacement: z.literal(false),
      sourceGeometryPreserved: z.literal(true),
      sourceAlphaPreserved: z.literal(true),
      deploymentAuthorized: z.literal(false),
      deploymentPerformed: z.literal(false),
      fullSkillCoverageProven: z.literal(false),
      clientCompatibilityProven: z.literal(false),
    })
    .strict(),
};

const asepriteProjectsProvenanceSchema = z
  .object({
    ...historicalReferenceOutputEvidenceFields,
    kind: z.literal("profession-reference-projects-v2"),
  })
  .strict();

const validationProvenanceSchema = z
  .object({
    ...historicalReferenceOutputEvidenceFields,
    kind: z.literal("profession-reference-validation-v2"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();

const sourcePreviewProvenanceSchema = z
  .object({
    ...historicalReferenceOutputEvidenceFields,
    kind: z.literal("profession-source-frame-preview-v2"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
  })
  .strict();

const resultPreviewProvenanceSchema = z
  .object({
    ...historicalReferenceOutputEvidenceFields,
    kind: z.literal("profession-reference-result-preview-v2"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
    sourcePreview: boundArtifactSchema,
  })
  .strict();

const legacyProjectsProvenanceSchema = z
  .object({
    ...legacyOutputEvidenceFields,
    kind: z.literal("profession-aseprite-projects-v1"),
  })
  .strict();

const legacyValidationProvenanceSchema = z
  .object({
    ...legacyOutputEvidenceFields,
    kind: z.literal("profession-aseprite-validation-v1"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();

const legacySourcePreviewProvenanceSchema = z
  .object({
    ...legacyOutputEvidenceFields,
    kind: z.literal("profession-source-frame-preview-v1"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
  })
  .strict();

const legacyResultPreviewProvenanceSchema = z
  .object({
    ...legacyOutputEvidenceFields,
    kind: z.literal("profession-aseprite-result-preview-v1"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
    sourcePreview: boundArtifactSchema,
  })
  .strict();

/** 全代际只读 schema；历史分支只供任务详情读取，不授权新 passed 或 Package 消费。 */
export const professionSkillOutputProvenanceSchema = z.discriminatedUnion(
  "kind",
  [
    readableCurrentCreativeProjectsProvenanceSchema,
    readableCurrentCreativeValidationProvenanceSchema,
    readableCurrentCreativeSourcePreviewProvenanceSchema,
    readableCurrentCreativeResultPreviewProvenanceSchema,
    historicalCreativeProjectsProvenanceSchema,
    historicalCreativeValidationProvenanceSchema,
    historicalCreativeSourcePreviewProvenanceSchema,
    historicalCreativeResultPreviewProvenanceSchema,
    asepriteProjectsProvenanceSchema,
    validationProvenanceSchema,
    sourcePreviewProvenanceSchema,
    resultPreviewProvenanceSchema,
    legacyProjectsProvenanceSchema,
    legacyValidationProvenanceSchema,
    legacySourcePreviewProvenanceSchema,
    legacyResultPreviewProvenanceSchema,
  ],
);

/** 经过严格读取校验的 Profession 输出来源元数据。 */
export type ProfessionSkillOutputProvenance = z.infer<
  typeof professionSkillOutputProvenanceSchema
>;
