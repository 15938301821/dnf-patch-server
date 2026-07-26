/**
 * @fileoverview 定义 Package V3 三个最终输出 Artifact 的固定名称、媒体类型与严格 provenance；
 * 不签发上传 URL、不读取对象正文、不写数据库，也不授权 `npk-package` capability。
 * @module modules/job/style-package-artifact-evidence-contracts
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * 调用关系：未来 Package Worker 在申请上传前生成这些 provenance；Package Report Repository 在同一
 * attempt 的 finalized Artifact 上重新解析并交叉核对。输入输出：输入是固定 lease/context/profile
 * 摘要和已 finalize Artifact 身份，输出是严格的角色证据类型。副作用：无。安全边界：Worker 不能
 * 用任意 logicalName、媒体类型或开放 JSON 伪装三种角色；每个后续角色必须反向绑定此前角色的
 * Artifact ID 与 SHA-256，四项安全状态始终为 false。
 */
import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";
import {
  stylePackageAttemptV3Schema,
  stylePackageSafetyStateV3Schema,
} from "./style-package-production.contracts.js";

/** 最终候选 NPK 的固定逻辑名称；不是本机路径，也不能由 Worker 输入替换。 */
export const stylePackageCandidateLogicalNameV3 = "candidate.npk";
/** Server 可审计的规范 manifest 固定逻辑名称。 */
export const stylePackageManifestLogicalNameV3 = "package-manifest.json";
/** 独立验证结果固定逻辑名称。 */
export const stylePackageValidationLogicalNameV3 = "package-validation.json";

/** JSON 角色的固定 MIME；候选 NPK 的 MIME 已冻结在 package profile。 */
export const stylePackageArtifactMediaTypesV3 = {
  manifest: "application/json",
  validation: "application/json",
} as const;

/** 已 finalize 的前置 Artifact 身份，后续角色用它阻止替换候选 NPK 或 manifest。 */
const stylePackageArtifactReferenceV3Schema = z
  .object({
    artifactId: z.uuid(),
    sha256: sha256Schema,
  })
  .strict();

/** 三种输出角色共享的当前 package attempt 归属，不允许携带路径、命令或任意参数。 */
const stylePackageArtifactProvenanceBaseV3Schema = z.object({
  schemaVersion: z.literal(3),
  jobId: z.uuid(),
  attempt: stylePackageAttemptV3Schema,
  packageContextSha256: sha256Schema,
  packageProfileSha256: sha256Schema,
  safety: stylePackageSafetyStateV3Schema,
});

/** 候选 NPK 的 provenance；对象字节摘要由 Artifact 元数据承载，不能由 JSON 重复声明。 */
export const stylePackageCandidateArtifactProvenanceV3Schema =
  stylePackageArtifactProvenanceBaseV3Schema
    .extend({ kind: z.literal("style-package-candidate-npk-v3") })
    .strict();

/** 规范 manifest 必须反向引用刚刚 finalize 的候选 NPK。 */
export const stylePackageManifestArtifactProvenanceV3Schema =
  stylePackageArtifactProvenanceBaseV3Schema
    .extend({
      kind: z.literal("style-package-manifest-v3"),
      package: stylePackageArtifactReferenceV3Schema,
    })
    .strict();

/** 独立验证结果必须同时反向引用候选 NPK 与其规范 manifest。 */
export const stylePackageValidationArtifactProvenanceV3Schema =
  stylePackageArtifactProvenanceBaseV3Schema
    .extend({
      kind: z.literal("style-package-validation-v3"),
      package: stylePackageArtifactReferenceV3Schema,
      manifest: stylePackageArtifactReferenceV3Schema,
    })
    .strict();

/** Package V3 输出 Artifact 允许的唯一 provenance 角色；未知字段在每个分支均被拒绝。 */
export const stylePackageArtifactProvenanceV3Schema = z.discriminatedUnion(
  "kind",
  [
    stylePackageCandidateArtifactProvenanceV3Schema,
    stylePackageManifestArtifactProvenanceV3Schema,
    stylePackageValidationArtifactProvenanceV3Schema,
  ],
);

/** 候选 NPK 上传 provenance。 */
export type StylePackageCandidateArtifactProvenanceV3 = z.infer<
  typeof stylePackageCandidateArtifactProvenanceV3Schema
>;
/** 规范 manifest 上传 provenance。 */
export type StylePackageManifestArtifactProvenanceV3 = z.infer<
  typeof stylePackageManifestArtifactProvenanceV3Schema
>;
/** 独立验证上传 provenance。 */
export type StylePackageValidationArtifactProvenanceV3 = z.infer<
  typeof stylePackageValidationArtifactProvenanceV3Schema
>;
