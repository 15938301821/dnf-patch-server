/**
 * @fileoverview 解析浏览器制作任务的 Package V3 三项终态 Artifact；不签发下载 URL、读取对象正文
 * 或放宽任务所有权。PatchTaskRepository 委托本文件执行跨聚合证据查询。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - 完整实机验收发现浏览器只能看到候选包单项元数据
 *
 * 调用关系：PatchTaskRepository 传入 DatabaseService 与已认证用户 ID；本文件读取 Run、Package
 * 聚合、passed attempt 证据和 Artifact 元数据，返回固定角色的脱敏 ViewModel。
 * 输入输出：输入为已校验 Run ID 和认证上下文中的 ownerUserId；输出严格按 candidate、manifest、
 * validation 排序，任一证据缺失、复用或摘要不一致时返回 undefined。
 * 副作用：仅执行数据库读取，不访问对象存储、不签名 URL、不修改历史 Job、Run 或 Artifact。
 * 安全边界：有效浏览器身份不能替代 Run 所有权；三个 Artifact 必须来自同一 passed Run 和唯一
 * passed Package attempt，且 ID 与 SHA-256 必须和终态证据逐项一致。
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { artifacts, runs } from "../../common/db/schema.js";
import {
  stylePackageAttemptEvidences,
  stylePackages,
} from "../../common/db/style-package-schema.js";
import type {
  PatchTaskArtifactRole,
  PatchTaskArtifactView,
} from "./patch-task.contracts.js";

interface ArtifactReference {
  role: PatchTaskArtifactRole;
  artifactId: string;
  sha256: string;
}

/**
 * 按固定角色读取当前用户已通过任务的三项 Package V3 Artifact 元数据。
 *
 * @param connection Job 模块注入的数据库连接；查询不会开启写事务或锁定历史终态行。
 * @param runId 来自已通过 UUID schema 的任务 path，同时也是 PatchTask 的稳定 ID。
 * @param ownerUserId 从浏览器 Access Token 解析的持久化用户 ID，不能由请求 body 提供。
 * @returns 三项证据完整时返回固定顺序的脱敏元数据，否则返回 undefined 并禁止后续下载授权。
 */
export async function findPatchTaskArtifacts(
  connection: DatabaseService,
  runId: string,
  ownerUserId: string,
): Promise<PatchTaskArtifactView[] | undefined> {
  // 第一步：同时约束 Run 所有权、聚合终态和 attempt 终态；出现多个 passed attempt 视为证据异常。
  const evidences = await connection.database
    .select({
      aggregatePackageArtifactId: stylePackages.packageArtifactId,
      aggregateManifestSha256: stylePackages.manifestSha256,
      packageArtifactId: stylePackageAttemptEvidences.packageArtifactId,
      packageSha256: stylePackageAttemptEvidences.packageSha256,
      manifestArtifactId: stylePackageAttemptEvidences.manifestArtifactId,
      manifestSha256: stylePackageAttemptEvidences.manifestSha256,
      validationArtifactId: stylePackageAttemptEvidences.validationArtifactId,
      validationSha256: stylePackageAttemptEvidences.validationSha256,
    })
    .from(stylePackages)
    .innerJoin(runs, eq(runs.id, stylePackages.runId))
    .innerJoin(
      stylePackageAttemptEvidences,
      and(
        eq(stylePackageAttemptEvidences.runId, stylePackages.runId),
        eq(stylePackageAttemptEvidences.stylePackageId, stylePackages.id),
      ),
    )
    .where(
      and(
        eq(stylePackages.runId, runId),
        eq(stylePackages.status, "passed"),
        eq(stylePackageAttemptEvidences.status, "passed"),
        eq(runs.ownerUserId, ownerUserId),
      ),
    )
    .limit(2);
  const evidence = evidences.length === 1 ? evidences[0] : undefined;
  if (!evidence) return undefined;

  const references = artifactReferences(evidence);
  if (!references) return undefined;

  // 第二步：只读取同一 Run 下的精确三个 ID；Artifact 表缺项或摘要漂移时不能返回部分成功。
  const rows = await connection.database
    .select({
      artifactId: artifacts.id,
      artifactName: artifacts.logicalName,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, runId),
        inArray(
          artifacts.id,
          references.map((reference) => reference.artifactId),
        ),
      ),
    );
  const rowsById = new Map(rows.map((row) => [row.artifactId, row]));
  if (rowsById.size !== references.length) return undefined;

  // 第三步：按稳定角色顺序映射公开 ViewModel，并再次比对终态证据中的逐角色 SHA-256。
  const result = references.map((reference) => {
    const row = rowsById.get(reference.artifactId);
    return row && row.sha256.toUpperCase() === reference.sha256.toUpperCase()
      ? { ...row, role: reference.role }
      : undefined;
  });
  return result.every(
    (item): item is PatchTaskArtifactView => item !== undefined,
  )
    ? result
    : undefined;
}

/**
 * 把 nullable 数据库证据收紧为三个互不复用的角色引用。
 *
 * @param evidence 唯一 passed attempt 与 Package 聚合的联合投影。
 * @returns 聚合引用、摘要和三角色唯一性全部一致时返回引用，否则失败关闭。
 */
function artifactReferences(evidence: {
  aggregatePackageArtifactId: string | null;
  aggregateManifestSha256: string | null;
  packageArtifactId: string | null;
  packageSha256: string | null;
  manifestArtifactId: string | null;
  manifestSha256: string | null;
  validationArtifactId: string | null;
  validationSha256: string | null;
}): ArtifactReference[] | undefined {
  if (
    !evidence.packageArtifactId ||
    !evidence.packageSha256 ||
    !evidence.manifestArtifactId ||
    !evidence.manifestSha256 ||
    !evidence.validationArtifactId ||
    !evidence.validationSha256 ||
    evidence.aggregatePackageArtifactId !== evidence.packageArtifactId ||
    evidence.aggregateManifestSha256?.toUpperCase() !==
      evidence.manifestSha256.toUpperCase()
  ) {
    return undefined;
  }
  const references: ArtifactReference[] = [
    {
      role: "candidate",
      artifactId: evidence.packageArtifactId,
      sha256: evidence.packageSha256,
    },
    {
      role: "manifest",
      artifactId: evidence.manifestArtifactId,
      sha256: evidence.manifestSha256,
    },
    {
      role: "validation",
      artifactId: evidence.validationArtifactId,
      sha256: evidence.validationSha256,
    },
  ];
  return new Set(references.map((reference) => reference.artifactId)).size ===
    references.length
    ? references
    : undefined;
}
