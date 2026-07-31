/**
 * @fileoverview 在两次短数据库事务中准备 Profession V6 官方逐帧 target 事实；不读取对象正文、
 * 不调用图片模型、不执行本机工具，也不更新 Job 或 production 终态。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：prepare Service 先调用 inspect；若需读正文，则在事务外通过 ObjectStoragePort 复读
 * target/source 两份 Artifact，完成严格解析后调用 commit。输入是 Controller 已校验的 exact lease DTO，
 * 输出是 prepared 回执、只供 Service 使用的受控对象读取声明，或有限拒绝状态。
 * 副作用：inspect 只取得短暂 Job/production/upload/target row lock；commit 重新按相同顺序锁定并一次
 * 插入全部逐帧行。任一失败会回滚，不留下部分 target。
 * 安全边界：lease 是带过期时间和唯一编号的任务编辑锁；两次事务都使用数据库时间复核 Worker、
 * leaseId、attempt、V3 contract、冻结技能、production、finalized upload、Artifact/provenance 和官方 source。
 * 对象存储 I/O 不得移入事务；同一 manifest 仅在已有行完整时幂等，不同或部分 manifest 必须 fail-closed。
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { ObjectStorageVerifiedReadRequest } from "../../common/storage/object-storage.client.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import { artifacts, jobs, npkInventories } from "../../common/db/schema.js";
import { styleSkillProductions } from "../../common/db/studio-schema.js";
import { stableStringifyJcsV1 } from "../../common/utils/canonical.js";
import {
  databaseNow,
  type JobTransaction,
} from "./job-run-event.repository-support.js";
import {
  resolveProfessionExecutionContext,
  type ResolveProfessionExecutionContextResult,
} from "./profession-execution-context.js";
import { professionSourceFrameManifestProvenanceSchema } from "./profession-source-context.contracts.js";
import {
  professionTargetFrameManifestProvenanceSchema,
  type PrepareProfessionTargetFramesInput,
  type ProfessionTargetFrameManifestProvenance,
  type ProfessionTargetFramePreparationView,
} from "./profession-target-frame-prepare.contracts.js";
import {
  createProfessionTargetFrameRows,
  resolvePreparedProfessionTargetFrames,
  type PreparedProfessionTargetFrameExpectation,
} from "./profession-target-frame-prepare.repository-support.js";
import { professionSourceFrameManifestMaxBytes } from "./profession-source-frame-manifest.js";
import {
  professionTargetFrameManifestMaxBytes,
  type ProfessionTargetFrameManifest,
} from "./profession-target-frame-manifest.js";

type GateFailure = Exclude<
  ResolveProfessionExecutionContextResult,
  { status: "accepted" }
>;

/** Repository 对外的有限拒绝状态；Service 映射时不得泄露具体数据库字段。 */
export type ProfessionTargetFramePreparationFailure =
  | GateFailure
  | { status: "job-contract-mismatch" }
  | { status: "skill-production-evidence-mismatch" }
  | { status: "manifest-evidence-mismatch" }
  | { status: "source-evidence-mismatch" }
  | { status: "preparation-conflict" };

/** 事务外只允许读取这两个已由数据库归属和摘要冻结的小型对象。 */
export interface ProfessionTargetFramePreparationRead {
  target: ObjectStorageVerifiedReadRequest;
  source: ObjectStorageVerifiedReadRequest;
  targetProvenance: ProfessionTargetFrameManifestProvenance;
  sourceByteLength: number;
  sourceToolSha256: string;
  frozenEntries: readonly { sourceMetadataSha256: string }[];
}

/** 首次检查返回幂等成功、受控读取声明或稳定拒绝。 */
export type InspectProfessionTargetFramesResult =
  | ProfessionTargetFramePreparationFailure
  | { status: "prepared"; preparation: ProfessionTargetFramePreparationView }
  | { status: "read-required"; read: ProfessionTargetFramePreparationRead };

/** 第二次事务只能返回 prepared 或有限拒绝，不会触发对象读取。 */
export type CommitProfessionTargetFramesResult =
  | ProfessionTargetFramePreparationFailure
  | { status: "prepared"; preparation: ProfessionTargetFramePreparationView };

interface LockedPreparationEvidence {
  status: "ready";
  runId: string;
  manifestUploadId: string;
  read: ProfessionTargetFramePreparationRead;
  existingRows: readonly (typeof professionSkillFrameTargets.$inferSelect)[];
}

type ResolveLockedPreparationResult =
  | ProfessionTargetFramePreparationFailure
  | LockedPreparationEvidence;

@Injectable()
/** V6 target prepare 的数据库边界，拥有 Job 锁、Artifact 归属查询与逐帧事实事务写入。 */
export class ProfessionTargetFramePrepareRepository {
  /** @param connection 服务进程共享 Drizzle 连接；Controller 和 Worker 不得直接访问。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 第一次短事务：判断完整幂等或为 Service 冻结两份对象读取声明。
   * @param jobId 内部路由 path 已按 UUID 校验的 Profession Job。
   * @param input 当前 Worker claim 与 target manifest Artifact 声明。
   * @returns prepared 不需读对象；read-required 只能由 Service 消费；拒绝状态不返回部分证据。
   */
  async inspect(
    jobId: string,
    input: PrepareProfessionTargetFramesInput,
  ): Promise<InspectProfessionTargetFramesResult> {
    return this.connection.database.transaction(async (transaction) => {
      const resolved = await resolveLockedPreparation(
        transaction,
        jobId,
        input,
      );
      if (resolved.status !== "ready") return resolved;
      if (resolved.existingRows.length === 0) {
        return { status: "read-required", read: resolved.read };
      }
      const preparation = resolvePreparedProfessionTargetFrames(
        resolved.existingRows,
        expectedRows(jobId, input, resolved),
      );
      return preparation
        ? { status: "prepared", preparation }
        : { status: "preparation-conflict" };
    });
  }

  /**
   * 第二次短事务：重新复核全部数据库证据，再一次插入已解析 manifest 的所有帧。
   * @param jobId 与 inspect 相同的 Job UUID。
   * @param input 与 inspect 相同的 exact lease 与 manifest Artifact 声明。
   * @param manifest Service 已从指定 target 对象严格解析并与 source 正文逐帧交叉核验的值。
   * @param inspected inspect 返回且实际用于对象读取的证据快照；任何变化都拒绝提交。
   * @returns 首次写入或完整并发幂等时的 prepared 回执；不会返回部分行。
   */
  async commit(
    jobId: string,
    input: PrepareProfessionTargetFramesInput,
    manifest: ProfessionTargetFrameManifest,
    inspected: ProfessionTargetFramePreparationRead,
  ): Promise<CommitProfessionTargetFramesResult> {
    return this.connection.database.transaction(async (transaction) => {
      const resolved = await resolveLockedPreparation(
        transaction,
        jobId,
        input,
      );
      if (resolved.status !== "ready") return resolved;
      if (!samePreparationRead(resolved.read, inspected)) {
        return { status: "preparation-conflict" };
      }
      const expectation = expectedRows(jobId, input, resolved);
      if (resolved.existingRows.length > 0) {
        const preparation = resolvePreparedProfessionTargetFrames(
          resolved.existingRows,
          expectation,
        );
        return preparation
          ? { status: "prepared", preparation }
          : { status: "preparation-conflict" };
      }
      const frameCount = manifest.entries.reduce(
        (total, entry) => total + entry.frames.length,
        0,
      );
      if (
        manifest.sourceSha256 !== resolved.read.targetProvenance.sourceSha256 ||
        manifest.sourceFrameManifestSha256 !==
          resolved.read.targetProvenance.sourceFrameManifestSha256 ||
        manifest.targetFrameCount !==
          resolved.read.targetProvenance.targetFrameCount ||
        manifest.targetPixelCount !==
          resolved.read.targetProvenance.targetPixelCount ||
        frameCount !== resolved.read.targetProvenance.frameCount
      ) {
        return { status: "manifest-evidence-mismatch" };
      }
      const now = await databaseNow(transaction);
      const rows = createProfessionTargetFrameRows(manifest, {
        runId: resolved.runId,
        jobId,
        workerId: input.workerId,
        leaseId: input.leaseId,
        attempt: input.attempt,
        skillId: input.skillId,
        manifestArtifactId: input.manifestArtifactId,
        manifestUploadId: resolved.manifestUploadId,
        manifestSha256: input.manifestSha256,
        sourceRunId: resolved.read.targetProvenance.sourceRunId,
        sourceFrameManifestArtifactId:
          resolved.read.targetProvenance.sourceFrameManifestArtifactId,
        sourceFrameManifestSha256:
          resolved.read.targetProvenance.sourceFrameManifestSha256,
        sourceSha256: resolved.read.targetProvenance.sourceSha256,
        createdAt: now,
      });
      await transaction.insert(professionSkillFrameTargets).values(rows);
      const preparation = resolvePreparedProfessionTargetFrames(
        [...rows].sort((left, right) => left.frameOrdinal - right.frameOrdinal),
        expectation,
      );
      if (!preparation) {
        throw new Error("PROFESSION_TARGET_FRAME_INSERT_INVARIANT_FAILED");
      }
      return { status: "prepared", preparation };
    });
  }
}

/** 在固定锁序中恢复 prepare 所需的全部权威数据库证据。 */
async function resolveLockedPreparation(
  transaction: JobTransaction,
  jobId: string,
  input: PrepareProfessionTargetFramesInput,
): Promise<ResolveLockedPreparationResult> {
  const [job] = await transaction
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1)
    .for("update");
  if (!job) return { status: "lease-mismatch" };
  const now = await databaseNow(transaction);
  const gate = resolveProfessionExecutionContext(job, input, now);
  if (gate.status !== "accepted") return gate;
  if (gate.context.contractVersion !== 2 || !gate.context.targetFramePolicy) {
    return { status: "job-contract-mismatch" };
  }

  const [production] = await transaction
    .select()
    .from(styleSkillProductions)
    .where(
      and(
        eq(styleSkillProductions.runId, job.runId),
        eq(styleSkillProductions.skillId, input.skillId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !production ||
    production.professionId !== gate.context.professionId ||
    production.styleId !== gate.context.styleId ||
    production.sourceRunId !== gate.context.skill.sourceEvidence.sourceRunId ||
    production.sourceFrameManifestArtifactId !==
      gate.context.skill.sourceEvidence.sourceFrameManifestArtifactId ||
    production.promptSha256.toUpperCase() !==
      gate.context.skill.promptSha256.toUpperCase() ||
    production.status !== "planned" ||
    production.finishedAt !== null
  ) {
    return { status: "skill-production-evidence-mismatch" };
  }

  const [target] = await transaction
    .select({
      uploadId: artifactUploadSessions.id,
      objectKey: artifactUploadSessions.objectKey,
      uploadLogicalName: artifactUploadSessions.logicalName,
      uploadMediaType: artifactUploadSessions.mediaType,
      uploadByteLength: artifactUploadSessions.expectedByteLength,
      uploadSha256: artifactUploadSessions.expectedSha256,
      uploadProvenance: artifactUploadSessions.provenance,
      finalizedAt: artifactUploadSessions.finalizedAt,
      objectDeletedAt: artifactUploadSessions.objectDeletedAt,
      artifactLogicalName: artifacts.logicalName,
      artifactStorageKey: artifacts.storageKey,
      artifactMediaType: artifacts.mediaType,
      artifactByteLength: artifacts.byteLength,
      artifactSha256: artifacts.sha256,
      artifactProvenance: artifacts.provenance,
    })
    .from(artifactUploadSessions)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, artifactUploadSessions.runId),
        eq(artifacts.id, artifactUploadSessions.artifactId),
      ),
    )
    .where(
      and(
        eq(artifactUploadSessions.runId, job.runId),
        eq(artifactUploadSessions.jobId, jobId),
        eq(artifactUploadSessions.workerId, input.workerId),
        eq(artifactUploadSessions.leaseId, input.leaseId),
        eq(artifactUploadSessions.attempt, input.attempt),
        eq(artifactUploadSessions.artifactId, input.manifestArtifactId),
        eq(artifactUploadSessions.status, "finalized"),
      ),
    )
    .limit(1)
    .for("update");
  const targetProvenance =
    professionTargetFrameManifestProvenanceSchema.safeParse(
      target?.uploadProvenance,
    );
  const artifactProvenance =
    professionTargetFrameManifestProvenanceSchema.safeParse(
      target?.artifactProvenance,
    );
  const expectedLogicalName = targetManifestLogicalName(input.skillId);
  if (
    !target ||
    !targetProvenance.success ||
    !artifactProvenance.success ||
    stableStringifyJcsV1(targetProvenance.data) !==
      stableStringifyJcsV1(artifactProvenance.data) ||
    target.finalizedAt === null ||
    target.objectDeletedAt !== null ||
    target.objectKey !== target.artifactStorageKey ||
    target.uploadLogicalName !== expectedLogicalName ||
    target.artifactLogicalName !== expectedLogicalName ||
    target.uploadMediaType !== input.manifestMediaType ||
    target.artifactMediaType !== input.manifestMediaType ||
    target.uploadByteLength !== input.manifestByteLength ||
    target.artifactByteLength !== input.manifestByteLength ||
    target.uploadSha256.toUpperCase() !== input.manifestSha256 ||
    target.artifactSha256.toUpperCase() !== input.manifestSha256 ||
    !matchesTargetProvenance(
      targetProvenance.data,
      jobId,
      job.runId,
      job.payloadSha256,
      input,
      gate.context.skill.sourceEvidence,
    )
  ) {
    return { status: "manifest-evidence-mismatch" };
  }

  const [source] = await transaction
    .select({
      runId: npkInventories.runId,
      inventoryId: npkInventories.id,
      sourceId: npkInventories.sourceId,
      sourceByteLength: npkInventories.sourceLength,
      sourceSha256: npkInventories.sourceSha256,
      artifactId: artifacts.id,
      logicalName: artifacts.logicalName,
      storageKey: artifacts.storageKey,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
      provenance: artifacts.provenance,
    })
    .from(npkInventories)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, npkInventories.runId),
        eq(artifacts.id, npkInventories.sourceFrameManifestArtifactId),
      ),
    )
    .where(
      and(
        eq(npkInventories.id, targetProvenance.data.sourceInventoryId),
        eq(npkInventories.runId, targetProvenance.data.sourceRunId),
        eq(npkInventories.status, "frozen"),
        eq(
          npkInventories.sourceFrameManifestArtifactId,
          targetProvenance.data.sourceFrameManifestArtifactId,
        ),
      ),
    )
    .limit(1);
  const sourceProvenance =
    professionSourceFrameManifestProvenanceSchema.safeParse(source?.provenance);
  if (
    !source ||
    !source.sourceId ||
    !sourceProvenance.success ||
    source.artifactId !== targetProvenance.data.sourceFrameManifestArtifactId ||
    source.logicalName !== "source-frame-manifest.json" ||
    source.mediaType !== "application/json" ||
    source.byteLength <= 0 ||
    source.byteLength > professionSourceFrameManifestMaxBytes ||
    source.sha256.toUpperCase() !==
      targetProvenance.data.sourceFrameManifestSha256 ||
    source.sourceSha256.toUpperCase() !== targetProvenance.data.sourceSha256 ||
    sourceProvenance.data.sourceId !== source.sourceId ||
    sourceProvenance.data.sourceSha256.toUpperCase() !==
      source.sourceSha256.toUpperCase()
  ) {
    return { status: "source-evidence-mismatch" };
  }

  const existingRows = await transaction
    .select()
    .from(professionSkillFrameTargets)
    .where(
      and(
        eq(professionSkillFrameTargets.jobId, jobId),
        eq(professionSkillFrameTargets.attempt, input.attempt),
        eq(professionSkillFrameTargets.skillId, input.skillId),
      ),
    )
    .orderBy(asc(professionSkillFrameTargets.frameOrdinal))
    .for("update");
  return {
    status: "ready",
    runId: job.runId,
    manifestUploadId: target.uploadId,
    existingRows,
    read: {
      target: {
        objectKey: target.objectKey,
        expectedMediaType: "application/json",
        expectedByteLength: target.uploadByteLength,
        expectedSha256: target.uploadSha256.toUpperCase(),
        maxByteLength: professionTargetFrameManifestMaxBytes,
      },
      source: {
        objectKey: source.storageKey,
        expectedMediaType: "application/json",
        expectedByteLength: source.byteLength,
        expectedSha256: source.sha256.toUpperCase(),
        maxByteLength: professionSourceFrameManifestMaxBytes,
      },
      targetProvenance: targetProvenance.data,
      sourceByteLength: source.sourceByteLength,
      sourceToolSha256: sourceProvenance.data.toolSha256.toUpperCase(),
      frozenEntries: gate.context.skill.sourceEvidence.sourceEntries.map(
        (entry) => ({
          sourceMetadataSha256: entry.sourceMetadataSha256.toUpperCase(),
        }),
      ),
    },
  };
}

function targetManifestLogicalName(skillId: string): string {
  return `profession-target-frame-manifest-${skillId}.json`;
}

function matchesTargetProvenance(
  provenance: ProfessionTargetFrameManifestProvenance,
  jobId: string,
  runId: string,
  jobPayloadSha256: string,
  input: PrepareProfessionTargetFramesInput,
  source: {
    sourceRunId: string;
    sourceInventoryId: string;
    sourceFrameManifestArtifactId: string;
  },
): boolean {
  return (
    provenance.jobId === jobId &&
    provenance.runId === runId &&
    provenance.jobPayloadSha256 === jobPayloadSha256.toUpperCase() &&
    provenance.attempt === input.attempt &&
    provenance.skillId === input.skillId &&
    provenance.sourceRunId === source.sourceRunId &&
    provenance.sourceInventoryId === source.sourceInventoryId &&
    provenance.sourceFrameManifestArtifactId ===
      source.sourceFrameManifestArtifactId
  );
}

function expectedRows(
  jobId: string,
  input: PrepareProfessionTargetFramesInput,
  evidence: LockedPreparationEvidence,
): PreparedProfessionTargetFrameExpectation {
  const provenance = evidence.read.targetProvenance;
  return {
    runId: evidence.runId,
    jobId,
    workerId: input.workerId,
    leaseId: input.leaseId,
    attempt: input.attempt,
    skillId: input.skillId,
    manifestArtifactId: input.manifestArtifactId,
    manifestSha256: input.manifestSha256,
    sourceRunId: provenance.sourceRunId,
    sourceFrameManifestArtifactId: provenance.sourceFrameManifestArtifactId,
    sourceFrameManifestSha256: provenance.sourceFrameManifestSha256,
    sourceSha256: provenance.sourceSha256,
    frameCount: provenance.frameCount,
    targetFrameCount: provenance.targetFrameCount,
    targetPixelCount: provenance.targetPixelCount,
  };
}

function samePreparationRead(
  current: ProfessionTargetFramePreparationRead,
  inspected: ProfessionTargetFramePreparationRead,
): boolean {
  return stableStringifyJcsV1(current) === stableStringifyJcsV1(inspected);
}
