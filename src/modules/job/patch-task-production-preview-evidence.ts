/**
 * @fileoverview 解析 PatchTask 历史与当前 production 预览 provenance，并严格匹配同代
 * validation/source/result；不查询数据库、不签发下载 URL，也不授权历史证据进入新生产。
 * @module modules/job/patch-task-production-preview-evidence
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - creative-stable-frame 生产证据同步
 *
 * 调用关系：预览 Repository 完成 Run 所有权与 finalized 上传查询后调用本文件；下游只接收
 * 已按 kind 判别的 provenance。输入是数据库 JSON，输出是历史只读或当前只读的有限类型。
 * 副作用：无。安全边界：V3、V4、V5 validation 只能与各自同代的两项预览组合；跨代或共同
 * 基线漂移必须 fail-closed，历史证据可读不表示它可成为新 passed 或 Package 输入。
 */
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import {
  professionSkillOutputProvenanceSchema,
  type ProfessionSkillOutputProvenance,
} from "./profession-skill-output-evidence.js";

/** 数据库中可用于浏览器预览的 validation 代际。 */
export type PatchTaskValidationProvenance = Extract<
  ProfessionSkillOutputProvenance,
  {
    kind:
      | "profession-aseprite-validation-v1"
      | "profession-reference-validation-v2"
      | "profession-creative-validation-v3"
      | "profession-creative-validation-v4"
      | "profession-creative-validation-v5";
  }
>;

/** 数据库中可用于浏览器源帧预览的 provenance 代际。 */
export type PatchTaskSourcePreviewProvenance = Extract<
  ProfessionSkillOutputProvenance,
  {
    kind:
      | "profession-source-frame-preview-v1"
      | "profession-source-frame-preview-v2"
      | "profession-creative-source-frame-preview-v3"
      | "profession-creative-source-frame-preview-v4"
      | "profession-creative-source-frame-preview-v5";
  }
>;

/** 数据库中可用于浏览器结果预览的 provenance 代际。 */
export type PatchTaskResultPreviewProvenance = Extract<
  ProfessionSkillOutputProvenance,
  {
    kind:
      | "profession-aseprite-result-preview-v1"
      | "profession-reference-result-preview-v2"
      | "profession-creative-result-preview-v3"
      | "profession-creative-result-preview-v4"
      | "profession-creative-result-preview-v5";
  }
>;

/** 浏览器 production 预览的两个固定角色；不能扩展为任意 Artifact 逻辑名。 */
export type PatchTaskProductionPreviewRole = "source-frame" | "aseprite-result";

/** 从未知数据库 JSON 解析一个受支持代际的 validation。 */
export function parsePatchTaskValidationProvenance(
  value: unknown,
): PatchTaskValidationProvenance | undefined {
  const parsed = professionSkillOutputProvenanceSchema.safeParse(value);
  if (!parsed.success) return undefined;
  switch (parsed.data.kind) {
    case "profession-aseprite-validation-v1":
    case "profession-reference-validation-v2":
    case "profession-creative-validation-v3":
    case "profession-creative-validation-v4":
    case "profession-creative-validation-v5":
      return parsed.data;
    default:
      return undefined;
  }
}

/**
 * 判定预览角色与 validation 是否属于同一代；kind 与 schema/quality 版本已由上游联合绑定。
 */
export function isMatchingPatchTaskPreviewProvenance(
  provenance: ProfessionSkillOutputProvenance,
  role: PatchTaskProductionPreviewRole,
  validation: PatchTaskValidationProvenance,
): provenance is
  | PatchTaskSourcePreviewProvenance
  | PatchTaskResultPreviewProvenance {
  switch (validation.kind) {
    case "profession-creative-validation-v5":
      return role === "source-frame"
        ? provenance.kind === "profession-creative-source-frame-preview-v5"
        : provenance.kind === "profession-creative-result-preview-v5";
    case "profession-creative-validation-v4":
      return role === "source-frame"
        ? provenance.kind === "profession-creative-source-frame-preview-v4"
        : provenance.kind === "profession-creative-result-preview-v4";
    case "profession-creative-validation-v3":
      return role === "source-frame"
        ? provenance.kind === "profession-creative-source-frame-preview-v3"
        : provenance.kind === "profession-creative-result-preview-v3";
    case "profession-reference-validation-v2":
      return role === "source-frame"
        ? provenance.kind === "profession-source-frame-preview-v2"
        : provenance.kind === "profession-reference-result-preview-v2";
    case "profession-aseprite-validation-v1":
      return role === "source-frame"
        ? provenance.kind === "profession-source-frame-preview-v1"
        : provenance.kind === "profession-aseprite-result-preview-v1";
  }
}

/** 判断严格预览联合中的源帧角色，供结果反向绑定检查窄化类型。 */
export function isPatchTaskSourcePreviewProvenance(
  provenance:
    | PatchTaskSourcePreviewProvenance
    | PatchTaskResultPreviewProvenance,
): provenance is PatchTaskSourcePreviewProvenance {
  return (
    provenance.kind === "profession-source-frame-preview-v1" ||
    provenance.kind === "profession-source-frame-preview-v2" ||
    provenance.kind === "profession-creative-source-frame-preview-v3" ||
    provenance.kind === "profession-creative-source-frame-preview-v4" ||
    provenance.kind === "profession-creative-source-frame-preview-v5"
  );
}

/** 判断严格预览联合中的结果角色，供 sourcePreview 反向绑定检查窄化类型。 */
export function isPatchTaskResultPreviewProvenance(
  provenance:
    | PatchTaskSourcePreviewProvenance
    | PatchTaskResultPreviewProvenance,
): provenance is PatchTaskResultPreviewProvenance {
  return (
    provenance.kind === "profession-aseprite-result-preview-v1" ||
    provenance.kind === "profession-reference-result-preview-v2" ||
    provenance.kind === "profession-creative-result-preview-v3" ||
    provenance.kind === "profession-creative-result-preview-v4" ||
    provenance.kind === "profession-creative-result-preview-v5"
  );
}

/**
 * 比较预览与 validation 的共同身份、来源、模型、质量、工具及安全字段。
 * kind 特有的 Artifact 反向绑定由 Repository 在此函数之外逐项复核。
 */
export function hasSamePatchTaskOutputEvidence(
  preview: PatchTaskSourcePreviewProvenance | PatchTaskResultPreviewProvenance,
  validation: PatchTaskValidationProvenance,
): boolean {
  return (
    sha256JcsV1(commonOutputEvidence(preview)) ===
    sha256JcsV1(commonOutputEvidence(validation))
  );
}

/** 删除角色专有绑定后，生成可作跨 Artifact 比较的有限公共证据。 */
function commonOutputEvidence(
  provenance:
    | PatchTaskValidationProvenance
    | PatchTaskSourcePreviewProvenance
    | PatchTaskResultPreviewProvenance,
): Record<string, unknown> {
  return {
    schemaVersion: provenance.schemaVersion,
    jobId: provenance.jobId,
    attempt: provenance.attempt,
    skillId: provenance.skillId,
    source: provenance.source,
    engineerPlan: provenance.engineerPlan,
    referenceImage: provenance.referenceImage,
    ...("referenceTransferQuality" in provenance
      ? { referenceTransferQuality: provenance.referenceTransferQuality }
      : {}),
    aseprite: provenance.aseprite,
    safety: provenance.safety,
  };
}
