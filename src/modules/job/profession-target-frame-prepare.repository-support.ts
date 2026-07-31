/**
 * @fileoverview 将已验证 V6 target manifest 投影为数据库逐帧行，并复核已有行的幂等完整性；
 * 不查询数据库、不启动事务、不访问对象存储，也不调用模型。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：target prepare Repository 在第二次短事务中调用投影函数并按返回顺序插入；预检和提交
 * 都调用已有行验证函数判断同一 manifest 是否已完整 prepare。输入是严格 manifest、当前 attempt 的
 * 数据库身份和已 finalize 上传证据，输出是内部 Drizzle 行或脱敏计数 ViewModel。
 * 副作用：仅生成 UUID 和内存数组。安全边界：`frameOrdinal` 保留清单原顺序，`generationOrdinal` 只覆盖
 * 生成帧；返回的插入数组按 LINK 依赖排序，保证即时自外键只引用已插入目标。部分行不能冒充幂等成功。
 */
import { randomUUID } from "node:crypto";
import type { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import type { ProfessionTargetFramePreparationView } from "./profession-target-frame-prepare.contracts.js";
import type { ProfessionTargetFrameManifest } from "./profession-target-frame-manifest.js";

type TargetFrameInsert = typeof professionSkillFrameTargets.$inferInsert;
type TargetFrameSelect = typeof professionSkillFrameTargets.$inferSelect;
type CompleteTargetFrameInsert = TargetFrameInsert & {
  generationOrdinal: number | null;
  linkTargetFrameIndex: number | null;
  sourceDecodedBgraSha256: string | null;
  sourceAlphaSha256: string | null;
};
type PreparedTargetFrameRow = Pick<
  TargetFrameSelect,
  | "frameOrdinal"
  | "runId"
  | "jobId"
  | "workerId"
  | "leaseId"
  | "attempt"
  | "skillId"
  | "manifestArtifactId"
  | "manifestSha256"
  | "sourceRunId"
  | "sourceFrameManifestArtifactId"
  | "sourceFrameManifestSha256"
  | "sourceSha256"
  | "entryIndex"
  | "frameIndex"
  | "targetPolicy"
  | "hidden"
  | "generationOrdinal"
  | "linkTargetFrameIndex"
  | "sourceDecodedBgraSha256"
  | "sourceAlphaSha256"
  | "width"
  | "height"
>;

/** 每帧重复保存的当前 attempt 与两份 manifest 归属，供数据库外键和独立审计使用。 */
export interface ProfessionTargetFrameRowContext {
  runId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  skillId: string;
  manifestArtifactId: string;
  manifestUploadId: string;
  manifestSha256: string;
  sourceRunId: string;
  sourceFrameManifestArtifactId: string;
  sourceFrameManifestSha256: string;
  sourceSha256: string;
  createdAt: Date;
}

/** 已有行完整性校验所需的固定计数与身份；全部来自当前数据库证据而非请求猜测。 */
export interface PreparedProfessionTargetFrameExpectation extends Omit<
  ProfessionTargetFrameRowContext,
  "manifestUploadId" | "createdAt"
> {
  frameCount: number;
  targetFrameCount: number;
  targetPixelCount: number;
}

/**
 * 把 manifest 展平为可满足同表 LINK 外键的插入序列。
 * @param manifest 已通过 source/target 正文和逐帧交叉核验的清单。
 * @param context 第二次事务重新取得的 Run/Job/lease/Artifact 归属与数据库时间。
 * @returns 每帧一行；数组顺序可能不同于 frameOrdinal，但所有 ordinal 保持原清单身份。
 */
export function createProfessionTargetFrameRows(
  manifest: ProfessionTargetFrameManifest,
  context: ProfessionTargetFrameRowContext,
): CompleteTargetFrameInsert[] {
  const rows: CompleteTargetFrameInsert[] = [];
  let frameOrdinal = 0;
  let generationOrdinal = 0;
  for (const entry of manifest.entries) {
    for (const frame of entry.frames) {
      const isGenerated = frame.targetPolicy === "generate-same-size";
      rows.push({
        id: randomUUID(),
        ...context,
        frameOrdinal,
        generationOrdinal: isGenerated ? generationOrdinal : null,
        entryIndex: entry.entryIndex,
        frameIndex: frame.frameIndex,
        internalPath: entry.internalPath,
        imgVersion: entry.imgVersion,
        frameType: frame.type,
        compressMode: frame.compressMode,
        hidden: frame.hidden,
        width: frame.width,
        height: frame.height,
        canvasWidth: frame.canvasWidth,
        canvasHeight: frame.canvasHeight,
        x: frame.x,
        y: frame.y,
        targetPolicy: frame.targetPolicy,
        linkTargetFrameIndex: frame.linkTargetIndex,
        sourceDecodedBgraSha256: frame.sourceDecodedBgraSha256,
        sourceAlphaSha256: frame.sourceAlphaSha256,
      });
      frameOrdinal += 1;
      if (isGenerated) generationOrdinal += 1;
    }
  }
  return topologicallyOrderTargetRows(rows);
}

/**
 * 验证数据库已有行确实是同一 manifest 的完整幂等结果。
 * @param rows Repository 按 frameOrdinal 查询的当前 job/attempt/skill 全部行。
 * @param expected 当前锁内恢复的 manifest/source/lease 身份和 provenance 聚合计数。
 * @returns 完整一致时返回 prepared 回执；部分、换 manifest、ordinal 或策略漂移时返回 undefined。
 */
export function resolvePreparedProfessionTargetFrames(
  rows: readonly PreparedTargetFrameRow[],
  expected: PreparedProfessionTargetFrameExpectation,
): ProfessionTargetFramePreparationView | undefined {
  if (rows.length !== expected.frameCount || rows.length === 0) {
    return undefined;
  }
  let targetFrameCount = 0;
  let targetPixelCount = 0;
  let nextGenerationOrdinal = 0;
  let currentEntryIndex = -1;
  let nextFrameIndex = 0;
  for (const [position, row] of rows.entries()) {
    if (
      row.frameOrdinal !== position ||
      row.runId !== expected.runId ||
      row.jobId !== expected.jobId ||
      row.workerId !== expected.workerId ||
      row.leaseId !== expected.leaseId ||
      row.attempt !== expected.attempt ||
      row.skillId !== expected.skillId ||
      row.manifestArtifactId !== expected.manifestArtifactId ||
      row.manifestSha256.toUpperCase() !== expected.manifestSha256 ||
      row.sourceRunId !== expected.sourceRunId ||
      row.sourceFrameManifestArtifactId !==
        expected.sourceFrameManifestArtifactId ||
      row.sourceFrameManifestSha256.toUpperCase() !==
        expected.sourceFrameManifestSha256 ||
      row.sourceSha256.toUpperCase() !== expected.sourceSha256
    ) {
      return undefined;
    }
    if (row.entryIndex !== currentEntryIndex) {
      if (row.entryIndex !== currentEntryIndex + 1 || row.frameIndex !== 0) {
        return undefined;
      }
      currentEntryIndex = row.entryIndex;
      nextFrameIndex = 0;
    }
    if (row.frameIndex !== nextFrameIndex) return undefined;
    nextFrameIndex += 1;

    if (row.targetPolicy === "generate-same-size") {
      if (
        row.hidden ||
        row.generationOrdinal !== nextGenerationOrdinal ||
        row.linkTargetFrameIndex !== null ||
        row.sourceDecodedBgraSha256 === null ||
        row.sourceAlphaSha256 === null
      ) {
        return undefined;
      }
      targetFrameCount += 1;
      targetPixelCount += row.width * row.height;
      nextGenerationOrdinal += 1;
      continue;
    }
    if (row.generationOrdinal !== null) return undefined;
    if (row.targetPolicy === "preserve-hidden-source") {
      if (
        !row.hidden ||
        row.linkTargetFrameIndex !== null ||
        row.sourceDecodedBgraSha256 === null ||
        row.sourceAlphaSha256 === null
      ) {
        return undefined;
      }
      continue;
    }
    if (
      row.targetPolicy !== "reuse-link-target" ||
      row.linkTargetFrameIndex === null ||
      row.sourceDecodedBgraSha256 !== null ||
      row.sourceAlphaSha256 !== null
    ) {
      return undefined;
    }
  }
  if (
    targetFrameCount !== expected.targetFrameCount ||
    targetPixelCount !== expected.targetPixelCount
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    status: "prepared",
    skillId: expected.skillId,
    manifestArtifactId: expected.manifestArtifactId,
    frameCount: rows.length,
    targetFrameCount,
    targetPixelCount,
  };
}

/**
 * 非 LINK 行先插入；LINK 只有在目标行已排入时才能进入下一层。schema 已证明无环，无法推进表示内部漂移。
 */
function topologicallyOrderTargetRows(
  rows: readonly CompleteTargetFrameInsert[],
): CompleteTargetFrameInsert[] {
  const ordered: CompleteTargetFrameInsert[] = [];
  const inserted = new Set<string>();
  let remaining = [...rows];
  while (remaining.length > 0) {
    const next: CompleteTargetFrameInsert[] = [];
    let progressed = false;
    for (const row of remaining) {
      const targetKey =
        row.linkTargetFrameIndex === null ||
        row.linkTargetFrameIndex === undefined
          ? undefined
          : frameKey(row.entryIndex, row.linkTargetFrameIndex);
      if (targetKey !== undefined && !inserted.has(targetKey)) {
        next.push(row);
        continue;
      }
      ordered.push(row);
      inserted.add(frameKey(row.entryIndex, row.frameIndex));
      progressed = true;
    }
    if (!progressed) {
      throw new Error("PROFESSION_TARGET_FRAME_LINK_ORDER_INVALID");
    }
    remaining = next;
  }
  return ordered;
}

function frameKey(entryIndex: number, frameIndex: number): string {
  return `${entryIndex}:${frameIndex}`;
}
