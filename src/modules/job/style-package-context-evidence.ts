/**
 * @fileoverview 纯函数复核 Package V3 的 Profession production、双 ZIP Artifact 与 finalized
 * upload session 三侧证据；不查询数据库、不读取对象正文，也不生成下载授权或改变业务状态。
 * @module modules/job/style-package-context-evidence
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 首个纵向协议切片
 *
 * 调用关系：StylePackageContextRepository 按固定表顺序读取数据库行后调用本文件；成功结果进入
 * context 信封，失败只返回 undefined。输入是数据库映射的有限字段，输出是 payload 冻结顺序的
 * 技能 ZIP 摘要。副作用：无。安全边界：finalized 只表示 Server 已复读对象并确认长度与哈希；
 * 本解析器还必须证明该会话属于产生 production 的精确 Worker/lease/attempt，且 provenance、
 * 对象 key、角色与 Aseprite 工具身份均未漂移，缺一项即 fail-closed。
 */
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import {
  currentProfessionSkillOutputProvenanceSchema,
  type CurrentProfessionSkillOutputProvenance,
} from "./profession-skill-output-evidence.js";
import type { StylePackageContextV3 } from "./style-package-production.contracts.js";

/** Package context 复核所需的单技能 production 数据库字段。 */
export interface StylePackageProductionEvidenceRow {
  skillId: string;
  productionContractVersion: number;
  professionId: string;
  styleId: string;
  jobId: string | null;
  workerId: string | null;
  leaseId: string | null;
  attempt: number | null;
  sourceRunId: string;
  sourceFrameManifestArtifactId: string;
  promptSha256: string;
  imageAttemptId: string | null;
  targetFrameManifestArtifactId: string | null;
  targetFrameManifestSha256: string | null;
  targetSetSha256: string | null;
  targetFrameCount: number | null;
  asepriteProfileId: string | null;
  asepriteBinarySha256: string | null;
  asepriteAdapterSha256: string | null;
  asepriteArtifactId: string | null;
  asepriteUploadId: string | null;
  validationArtifactId: string | null;
  validationUploadId: string | null;
  status: string;
  errorCode: string | null;
  finishedAt: Date | null;
}

/** 已 finalize Artifact 表中用于角色、对象和内容复核的有限字段。 */
export interface StylePackageArtifactEvidenceRow {
  id: string;
  runId: string;
  logicalName: string;
  storageKey: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  provenance: unknown;
}

/** Artifact upload session 中用于还原 producing lease 与 finalize 状态的有限字段。 */
export interface StylePackageUploadEvidenceRow {
  id: string;
  runId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  objectKey: string;
  logicalName: string;
  mediaType: string;
  expectedByteLength: number;
  expectedSha256: string;
  provenance: unknown;
  status: string;
  artifactId: string | null;
  finalizedAt: Date | null;
  objectDeletedAt: Date | null;
}

/** 当前 package Job payload 冻结的上游集合身份。 */
export interface StylePackageExpectedProductionSet {
  runId: string;
  professionId: string;
  styleId: string;
  selectedSkillIds: string[];
}

type CompleteProductionBase = StylePackageProductionEvidenceRow & {
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  asepriteBinarySha256: string;
  asepriteAdapterSha256: string;
  asepriteArtifactId: string;
  asepriteUploadId: string;
  validationArtifactId: string;
  validationUploadId: string;
};
type CompleteProduction =
  | (CompleteProductionBase & {
      productionContractVersion: 5;
      imageAttemptId: string;
      asepriteProfileId: "aseprite-cli";
    })
  | (CompleteProductionBase & {
      productionContractVersion: 6;
      imageAttemptId: null;
      targetFrameManifestArtifactId: string;
      targetFrameManifestSha256: string;
      targetSetSha256: string;
      targetFrameCount: number;
      asepriteProfileId: "aseprite-cli-v6";
    });

type PackageOutputProvenance = Extract<
  CurrentProfessionSkillOutputProvenance,
  {
    kind:
      | "profession-creative-projects-v5"
      | "profession-creative-validation-v5";
  }
>;
type PackageV6OutputProvenance = Extract<
  CurrentProfessionSkillOutputProvenance,
  {
    kind: "profession-target-projects-v6" | "profession-target-validation-v6";
  }
>;

/**
 * 复核全部上游证据并按 package payload 顺序生成技能输入。
 *
 * @param productions 同 producing Run 的全部 style_skill_productions 行。
 * @param artifactsRows productions 引用的 projects/validation Artifact 行。
 * @param uploadRows productions 保存的两类 upload session 行。
 * @param expected 当前 npk-package payload 和 Job 冻结的 Run、职业、风格及技能顺序。
 * @returns 全部三侧证据一致时返回有序 context 技能；任一缺失或漂移时返回 undefined。
 */
export function resolveStylePackageSkillInputs(
  productions: readonly StylePackageProductionEvidenceRow[],
  artifactsRows: readonly StylePackageArtifactEvidenceRow[],
  uploadRows: readonly StylePackageUploadEvidenceRow[],
  expected: StylePackageExpectedProductionSet,
): StylePackageContextV3["skills"] | undefined {
  const ordered = orderCompleteProductions(productions, expected);
  if (!ordered) return undefined;
  const artifactsById = new Map(artifactsRows.map((row) => [row.id, row]));
  const uploadsById = new Map(uploadRows.map((row) => [row.id, row]));
  if (
    artifactsRows.length !== ordered.length * 2 ||
    artifactsById.size !== artifactsRows.length ||
    uploadRows.length !== ordered.length * 2 ||
    uploadsById.size !== uploadRows.length
  ) {
    return undefined;
  }

  const skills: StylePackageContextV3["skills"] = [];
  for (const production of ordered) {
    const projects = resolveFinalizedRole(
      production,
      artifactsById.get(production.asepriteArtifactId),
      uploadsById.get(production.asepriteUploadId),
      expected.runId,
      "projects",
    );
    const validation = resolveFinalizedRole(
      production,
      artifactsById.get(production.validationArtifactId),
      uploadsById.get(production.validationUploadId),
      expected.runId,
      "validation",
    );
    if (
      !projects ||
      !validation ||
      !("asepriteProjects" in validation.provenance) ||
      sha256JcsV1(validation.provenance.source) !==
        sha256JcsV1(projects.provenance.source) ||
      validation.provenance.asepriteProjects.artifactId !==
        projects.artifact.id ||
      validation.provenance.asepriteProjects.sha256 !==
        projects.artifact.sha256.toUpperCase()
    ) {
      return undefined;
    }
    const common = {
      skillId: production.skillId,
      sourceSha256: projects.provenance.source.sourceSha256,
      promptSha256: production.promptSha256.toUpperCase(),
      productionAttempt: production.attempt,
      projectBundle: artifactSummary(projects.artifact),
      validationBundle: artifactSummary(validation.artifact),
    };
    if (production.productionContractVersion === 5) {
      if (
        projects.provenance.kind !== "profession-creative-projects-v5" ||
        validation.provenance.kind !== "profession-creative-validation-v5" ||
        sha256JcsV1(validation.provenance.referenceTransferQuality) !==
          sha256JcsV1(projects.provenance.referenceTransferQuality)
      ) {
        return undefined;
      }
      skills.push({ productionContractVersion: 5, ...common });
      continue;
    }
    if (
      projects.provenance.kind !== "profession-target-projects-v6" ||
      validation.provenance.kind !== "profession-target-validation-v6" ||
      sha256JcsV1(validation.provenance.targetFrameManifest) !==
        sha256JcsV1(projects.provenance.targetFrameManifest) ||
      sha256JcsV1(validation.provenance.targetSet) !==
        sha256JcsV1(projects.provenance.targetSet)
    ) {
      return undefined;
    }
    skills.push({
      productionContractVersion: 6,
      ...common,
      targetFrameManifest: {
        artifactId: production.targetFrameManifestArtifactId,
        sha256: production.targetFrameManifestSha256.toUpperCase(),
      },
      targetSetSha256: production.targetSetSha256.toUpperCase(),
      targetFrameCount: production.targetFrameCount,
    });
  }
  return skills;
}

/** 按冻结顺序补全 passed production，并拒绝额外技能、跨 Job 组合或复用角色证据。 */
function orderCompleteProductions(
  rows: readonly StylePackageProductionEvidenceRow[],
  expected: StylePackageExpectedProductionSet,
): CompleteProduction[] | undefined {
  if (rows.length !== expected.selectedSkillIds.length) return undefined;
  const bySkillId = new Map(rows.map((row) => [row.skillId, row]));
  if (bySkillId.size !== rows.length) return undefined;
  const ordered: CompleteProduction[] = [];
  const producingJobIds = new Set<string>();
  const artifactIds = new Set<string>();
  const uploadIds = new Set<string>();
  for (const skillId of expected.selectedSkillIds) {
    const row = bySkillId.get(skillId);
    if (
      !row ||
      row.professionId !== expected.professionId ||
      row.styleId !== expected.styleId ||
      row.status !== "passed" ||
      row.errorCode !== null ||
      row.finishedAt === null ||
      !row.jobId ||
      !row.workerId ||
      !row.leaseId ||
      row.attempt === null ||
      row.attempt < 1 ||
      !row.asepriteBinarySha256 ||
      !row.asepriteAdapterSha256 ||
      !row.asepriteArtifactId ||
      !row.asepriteUploadId ||
      !row.validationArtifactId ||
      !row.validationUploadId
    ) {
      return undefined;
    }
    const v5Complete =
      row.productionContractVersion === 5 &&
      row.imageAttemptId !== null &&
      row.asepriteProfileId === "aseprite-cli";
    const v6Complete =
      row.productionContractVersion === 6 &&
      row.imageAttemptId === null &&
      row.targetFrameManifestArtifactId !== null &&
      row.targetFrameManifestSha256 !== null &&
      row.targetSetSha256 !== null &&
      row.targetFrameCount !== null &&
      row.targetFrameCount >= 1 &&
      row.targetFrameCount <= 2_048 &&
      row.asepriteProfileId === "aseprite-cli-v6";
    if (!v5Complete && !v6Complete) return undefined;
    const roleArtifactIds = [row.asepriteArtifactId, row.validationArtifactId];
    const roleUploadIds = [row.asepriteUploadId, row.validationUploadId];
    if (
      roleArtifactIds.some((id) => artifactIds.has(id)) ||
      roleUploadIds.some((id) => uploadIds.has(id))
    ) {
      return undefined;
    }
    roleArtifactIds.forEach((id) => artifactIds.add(id));
    roleUploadIds.forEach((id) => uploadIds.add(id));
    producingJobIds.add(row.jobId);
    ordered.push(row as CompleteProduction);
  }
  return producingJobIds.size === 1 ? ordered : undefined;
}

/** 复核一个输出角色的 Artifact、upload session 与 production 三侧身份和内容。 */
function resolveFinalizedRole(
  production: CompleteProduction,
  artifact: StylePackageArtifactEvidenceRow | undefined,
  upload: StylePackageUploadEvidenceRow | undefined,
  runId: string,
  role: "projects" | "validation",
):
  | {
      artifact: StylePackageArtifactEvidenceRow;
      provenance: PackageOutputProvenance | PackageV6OutputProvenance;
    }
  | undefined {
  if (!artifact || !upload) return undefined;
  const artifactProvenance =
    currentProfessionSkillOutputProvenanceSchema.safeParse(artifact.provenance);
  const uploadProvenance =
    currentProfessionSkillOutputProvenanceSchema.safeParse(upload.provenance);
  const expectedKind =
    production.productionContractVersion === 6
      ? role === "projects"
        ? "profession-target-projects-v6"
        : "profession-target-validation-v6"
      : role === "projects"
        ? "profession-creative-projects-v5"
        : "profession-creative-validation-v5";
  const expectedName =
    role === "projects"
      ? "profession-aseprite-projects.zip"
      : "profession-aseprite-validation.zip";
  const expectedArtifactId =
    role === "projects"
      ? production.asepriteArtifactId
      : production.validationArtifactId;
  const expectedUploadId =
    role === "projects"
      ? production.asepriteUploadId
      : production.validationUploadId;
  if (
    !artifactProvenance.success ||
    !uploadProvenance.success ||
    artifactProvenance.data.kind !== expectedKind ||
    uploadProvenance.data.kind !== expectedKind ||
    sha256JcsV1(artifactProvenance.data) !==
      sha256JcsV1(uploadProvenance.data) ||
    !matchesProductionIdentity(artifactProvenance.data, production) ||
    artifact.id !== expectedArtifactId ||
    artifact.runId !== runId ||
    artifact.logicalName !== expectedName ||
    artifact.mediaType !== "application/zip" ||
    artifact.byteLength <= 0 ||
    upload.id !== expectedUploadId ||
    upload.runId !== runId ||
    upload.jobId !== production.jobId ||
    upload.workerId !== production.workerId ||
    upload.leaseId !== production.leaseId ||
    upload.attempt !== production.attempt ||
    upload.status !== "finalized" ||
    upload.artifactId !== artifact.id ||
    upload.finalizedAt === null ||
    upload.objectDeletedAt !== null ||
    upload.objectKey !== artifact.storageKey ||
    upload.logicalName !== artifact.logicalName ||
    upload.mediaType !== artifact.mediaType ||
    upload.expectedByteLength !== artifact.byteLength ||
    upload.expectedSha256.toUpperCase() !== artifact.sha256.toUpperCase()
  ) {
    return undefined;
  }
  return { artifact, provenance: artifactProvenance.data };
}

/** 将严格 provenance 与 production 中保存的来源、attempt 和 Aseprite 工具身份交叉核对。 */
function matchesProductionIdentity(
  provenance: PackageOutputProvenance | PackageV6OutputProvenance,
  production: CompleteProduction,
): boolean {
  const common =
    provenance.jobId === production.jobId &&
    provenance.attempt === production.attempt &&
    provenance.skillId === production.skillId &&
    provenance.source.runId === production.sourceRunId &&
    provenance.source.frameManifestArtifactId ===
      production.sourceFrameManifestArtifactId &&
    provenance.aseprite.binarySha256 ===
      production.asepriteBinarySha256.toUpperCase() &&
    provenance.aseprite.adapterSha256 ===
      production.asepriteAdapterSha256.toUpperCase();
  if (!common) return false;
  if (production.productionContractVersion === 5) {
    return (
      "referenceImage" in provenance &&
      provenance.referenceImage.imageAttemptId === production.imageAttemptId
    );
  }
  return (
    "targetFrameManifest" in provenance &&
    provenance.targetFrameManifest.artifactId ===
      production.targetFrameManifestArtifactId &&
    provenance.targetFrameManifest.sha256 ===
      production.targetFrameManifestSha256.toUpperCase() &&
    provenance.targetSet.sha256 === production.targetSetSha256.toUpperCase() &&
    provenance.targetSet.targetFrameCount === production.targetFrameCount
  );
}

/** 只公开 Artifact 的内容摘要，不泄露 storage key、session 或 provenance 正文。 */
function artifactSummary(
  artifact: StylePackageArtifactEvidenceRow,
): StylePackageContextV3["skills"][number]["projectBundle"] {
  return {
    artifactId: artifact.id,
    mediaType: "application/zip",
    byteLength: artifact.byteLength,
    sha256: artifact.sha256.toUpperCase(),
  };
}
