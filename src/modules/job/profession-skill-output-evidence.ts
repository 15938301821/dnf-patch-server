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

const outputEvidenceFields = {
  schemaVersion: z.literal(1),
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
  safety: z
    .object({
      referenceImageUsedForRuntimePixels: z.literal(false),
      deploymentAuthorized: z.literal(false),
      deploymentPerformed: z.literal(false),
      fullSkillCoverageProven: z.literal(false),
      clientCompatibilityProven: z.literal(false),
    })
    .strict(),
};

const asepriteProjectsProvenanceSchema = z
  .object({
    ...outputEvidenceFields,
    kind: z.literal("profession-aseprite-projects-v1"),
  })
  .strict();

const validationProvenanceSchema = z
  .object({
    ...outputEvidenceFields,
    kind: z.literal("profession-aseprite-validation-v1"),
    asepriteProjects: boundArtifactSchema,
  })
  .strict();

/** 两个固定输出角色的数据库 JSON 读取 schema；通过不代表对象正文已解压或客户端兼容。 */
export const professionSkillOutputProvenanceSchema = z.discriminatedUnion(
  "kind",
  [asepriteProjectsProvenanceSchema, validationProvenanceSchema],
);

/** 经过严格读取校验的 Profession 输出来源元数据。 */
export type ProfessionSkillOutputProvenance = z.infer<
  typeof professionSkillOutputProvenanceSchema
>;
