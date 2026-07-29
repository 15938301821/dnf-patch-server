/**
 * @fileoverview 定义 Profession Worker 两个固定 ZIP 输出的严格 provenance；不读取对象正文、
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

/** Worker 独立读取源帧、参考图和 runtime 后计算的固定质量摘要；不能由 Report DTO 自报。 */
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

const currentOutputEvidenceFields = {
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
    ...currentOutputEvidenceFields,
    kind: z.literal("profession-reference-projects-v2"),
  })
  .strict();

const validationProvenanceSchema = z
  .object({
    ...currentOutputEvidenceFields,
    kind: z.literal("profession-reference-validation-v2"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();

const sourcePreviewProvenanceSchema = z
  .object({
    ...currentOutputEvidenceFields,
    kind: z.literal("profession-source-frame-preview-v2"),
    frame: comparisonFrameSchema,
    asepriteValidation: boundArtifactSchema,
  })
  .strict();

const resultPreviewProvenanceSchema = z
  .object({
    ...currentOutputEvidenceFields,
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

/** 两个固定输出角色的数据库 JSON 读取 schema；通过不代表对象正文已解压或客户端兼容。 */
export const professionSkillOutputProvenanceSchema = z.discriminatedUnion(
  "kind",
  [
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
