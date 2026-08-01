/**
 * @fileoverview 在两次短事务中把 finalized 官方逐帧 PNG 绑定到 V6 prepared target 行；
 * 不读取对象正文、不调用模型，也不改变 Job 或技能生产终态。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - V6 逐帧模型输入冻结
 *
 * 调用关系：Source Service 先调用 inspect 取得幂等结果或受控对象读取声明，事务外验证 PNG 后再
 * 调用 commit。输入是 Controller 已校验的 exact lease 与 finalized Artifact 声明，输出是有限状态。
 * 副作用：两次事务都按 Job -> target -> upload/Artifact 的固定顺序加 row lock（行锁），commit 只把
 * source PNG 证据整组写入一条 target 行；失败会回滚且不留下部分字段。
 * 安全边界：Worker token 不等于租约所有权；仅 prepared 的 generate-same-size 行可登记，Artifact、
 * upload、provenance、长度和摘要必须属于同一 Run/Job/Worker/lease/attempt。同证据重试幂等，换证据冲突。
 */
import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import { artifacts, jobs } from "../../common/db/schema.js";
import type { ObjectStorageVerifiedReadRequest } from "../../common/storage/object-storage.client.js";
import { stableStringifyJcsV1 } from "../../common/utils/canonical.js";
import {
  databaseNow,
  type JobTransaction,
} from "./job-run-event.repository-support.js";
import {
  resolveProfessionExecutionContext,
  type ResolveProfessionExecutionContextResult,
} from "./profession-execution-context.js";
import {
  professionTargetFrameSourceProvenanceSchema,
  type ProfessionTargetFrameSourceProvenance,
  type ProfessionTargetFrameSourceView,
  type RegisterProfessionTargetFrameSourceInput,
} from "./profession-target-frame-prepare.contracts.js";

type GateFailure = Exclude<
  ResolveProfessionExecutionContextResult,
  { status: "accepted" }
>;

/** Source PNG 登记可公开映射的有限失败；不包含表名、对象 key 或像素正文。 */
export type ProfessionTargetFrameSourceFailure =
  | GateFailure
  | { status: "job-contract-mismatch" }
  | { status: "target-frame-not-found" }
  | { status: "target-frame-policy-mismatch" }
  | { status: "source-artifact-mismatch" }
  | { status: "source-registration-conflict" };

/** 事务外只允许读取当前锁内已完整复核的 PNG 对象。 */
export interface ProfessionTargetFrameSourceRead {
  targetId: string;
  artifactId: string;
  uploadId: string;
  read: ObjectStorageVerifiedReadRequest;
  provenance: ProfessionTargetFrameSourceProvenance;
  expected: { width: number; height: number; sourceAlphaSha256: string };
}

export type InspectProfessionTargetFrameSourceResult =
  | ProfessionTargetFrameSourceFailure
  | { status: "registered"; source: ProfessionTargetFrameSourceView }
  | { status: "read-required"; read: ProfessionTargetFrameSourceRead };

export type CommitProfessionTargetFrameSourceResult =
  | ProfessionTargetFrameSourceFailure
  | { status: "registered"; source: ProfessionTargetFrameSourceView };

interface LockedSourceEvidence {
  status: "ready";
  runId: string;
  target: typeof professionSkillFrameTargets.$inferSelect;
  artifactId: string;
  uploadId: string;
  provenance: ProfessionTargetFrameSourceProvenance;
  read: ObjectStorageVerifiedReadRequest;
}

type ResolveLockedSourceResult =
  | ProfessionTargetFrameSourceFailure
  | LockedSourceEvidence;

@Injectable()
/** 官方逐帧 PNG 的数据库所有者，负责租约锁、Artifact 归属和一次性 target 行更新。 */
export class ProfessionTargetFrameSourceRepository {
  constructor(private readonly connection: DatabaseService) {}

  /** 第一次短事务返回完整幂等结果或只供 Service 使用的受控 PNG 读取声明。 */
  inspect(
    jobId: string,
    input: RegisterProfessionTargetFrameSourceInput,
  ): Promise<InspectProfessionTargetFrameSourceResult> {
    return this.connection.database.transaction(async (transaction) => {
      const resolved = await resolveLockedSource(transaction, jobId, input);
      if (resolved.status !== "ready") return resolved;
      const existing = existingSourceView(resolved.target, input);
      if (existing === "conflict") {
        return { status: "source-registration-conflict" };
      }
      if (existing) return { status: "registered", source: existing };
      return {
        status: "read-required",
        read: sourceRead(resolved),
      };
    });
  }

  /**
   * 第二次短事务重新复核相同 target/Artifact 后写入成组 source PNG 证据。
   * @param inspected 首次事务实际用于对象读取的声明，防止两次事务间证据被替换。
   */
  commit(
    jobId: string,
    input: RegisterProfessionTargetFrameSourceInput,
    inspected: ProfessionTargetFrameSourceRead,
  ): Promise<CommitProfessionTargetFrameSourceResult> {
    return this.connection.database.transaction(async (transaction) => {
      const resolved = await resolveLockedSource(transaction, jobId, input);
      if (resolved.status !== "ready") return resolved;
      if (!sameSourceRead(sourceRead(resolved), inspected)) {
        return { status: "source-registration-conflict" };
      }
      const existing = existingSourceView(resolved.target, input);
      if (existing === "conflict") {
        return { status: "source-registration-conflict" };
      }
      if (existing) return { status: "registered", source: existing };
      const registeredAt = await databaseNow(transaction);
      const updated = await transaction
        .update(professionSkillFrameTargets)
        .set({
          sourcePngArtifactId: input.sourceArtifactId,
          sourcePngUploadId: resolved.uploadId,
          sourcePngSha256: input.sourceSha256,
          sourcePngByteLength: input.sourceByteLength,
          sourcePngRegisteredAt: registeredAt,
        })
        .where(
          and(
            eq(professionSkillFrameTargets.id, resolved.target.id),
            isNull(professionSkillFrameTargets.sourcePngArtifactId),
            isNull(professionSkillFrameTargets.sourcePngUploadId),
            isNull(professionSkillFrameTargets.sourcePngSha256),
            isNull(professionSkillFrameTargets.sourcePngByteLength),
            isNull(professionSkillFrameTargets.sourcePngRegisteredAt),
          ),
        );
      if (updated[0].affectedRows !== 1) {
        return { status: "source-registration-conflict" };
      }
      return { status: "registered", source: sourceView(input) };
    });
  }
}

async function resolveLockedSource(
  transaction: JobTransaction,
  jobId: string,
  input: RegisterProfessionTargetFrameSourceInput,
): Promise<ResolveLockedSourceResult> {
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

  const [target] = await transaction
    .select()
    .from(professionSkillFrameTargets)
    .where(
      and(
        eq(professionSkillFrameTargets.jobId, jobId),
        eq(professionSkillFrameTargets.attempt, input.attempt),
        eq(professionSkillFrameTargets.skillId, input.skillId),
        eq(professionSkillFrameTargets.entryIndex, input.entryIndex),
        eq(professionSkillFrameTargets.frameIndex, input.frameIndex),
      ),
    )
    .limit(1)
    .for("update");
  if (!target) return { status: "target-frame-not-found" };
  if (
    target.runId !== job.runId ||
    target.workerId !== input.workerId ||
    target.leaseId !== input.leaseId ||
    target.targetPolicy !== "generate-same-size" ||
    target.hidden ||
    target.sourceDecodedBgraSha256 === null ||
    target.sourceAlphaSha256 === null
  ) {
    return { status: "target-frame-policy-mismatch" };
  }

  const [artifact] = await transaction
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
        eq(artifactUploadSessions.artifactId, input.sourceArtifactId),
        eq(artifactUploadSessions.status, "finalized"),
      ),
    )
    .limit(1)
    .for("update");
  const uploadProvenance =
    professionTargetFrameSourceProvenanceSchema.safeParse(
      artifact?.uploadProvenance,
    );
  const artifactProvenance =
    professionTargetFrameSourceProvenanceSchema.safeParse(
      artifact?.artifactProvenance,
    );
  const expectedLogicalName = professionTargetFrameSourceLogicalName(
    input.skillId,
    input.entryIndex,
    input.frameIndex,
  );
  if (
    !artifact ||
    !uploadProvenance.success ||
    !artifactProvenance.success ||
    stableStringifyJcsV1(uploadProvenance.data) !==
      stableStringifyJcsV1(artifactProvenance.data) ||
    artifact.finalizedAt === null ||
    artifact.objectDeletedAt !== null ||
    artifact.objectKey !== artifact.artifactStorageKey ||
    artifact.uploadLogicalName !== expectedLogicalName ||
    artifact.artifactLogicalName !== expectedLogicalName ||
    artifact.uploadMediaType !== input.sourceMediaType ||
    artifact.artifactMediaType !== input.sourceMediaType ||
    artifact.uploadByteLength !== input.sourceByteLength ||
    artifact.artifactByteLength !== input.sourceByteLength ||
    artifact.uploadSha256.toUpperCase() !== input.sourceSha256 ||
    artifact.artifactSha256.toUpperCase() !== input.sourceSha256 ||
    !matchesSourceProvenance(
      uploadProvenance.data,
      jobId,
      job.runId,
      job.payloadSha256,
      input,
      target,
    )
  ) {
    return { status: "source-artifact-mismatch" };
  }
  return {
    status: "ready",
    runId: job.runId,
    target,
    artifactId: input.sourceArtifactId,
    uploadId: artifact.uploadId,
    provenance: uploadProvenance.data,
    read: {
      objectKey: artifact.objectKey,
      expectedMediaType: "image/png",
      expectedByteLength: input.sourceByteLength,
      expectedSha256: input.sourceSha256,
      maxByteLength: 64 * 1024 * 1024,
    },
  };
}

/** Worker 和 Server 共同使用的单帧 PNG 固定逻辑名；不是对象 key 或本机路径。 */
export function professionTargetFrameSourceLogicalName(
  skillId: string,
  entryIndex: number,
  frameIndex: number,
): string {
  return `profession-target-frame-source-${skillId}-${String(entryIndex)}-${String(frameIndex)}.png`;
}

function matchesSourceProvenance(
  provenance: ProfessionTargetFrameSourceProvenance,
  jobId: string,
  runId: string,
  payloadSha256: string,
  input: RegisterProfessionTargetFrameSourceInput,
  target: typeof professionSkillFrameTargets.$inferSelect,
): boolean {
  return (
    provenance.jobId === jobId &&
    provenance.runId === runId &&
    provenance.jobPayloadSha256 === payloadSha256.toUpperCase() &&
    provenance.attempt === input.attempt &&
    provenance.skillId === input.skillId &&
    provenance.entryIndex === input.entryIndex &&
    provenance.frameIndex === input.frameIndex &&
    provenance.width === target.width &&
    provenance.height === target.height &&
    provenance.sourceDecodedBgraSha256 === target.sourceDecodedBgraSha256 &&
    provenance.sourceAlphaSha256 === target.sourceAlphaSha256 &&
    provenance.targetPolicy === target.targetPolicy
  );
}

function existingSourceView(
  target: typeof professionSkillFrameTargets.$inferSelect,
  input: RegisterProfessionTargetFrameSourceInput,
): ProfessionTargetFrameSourceView | "conflict" | undefined {
  const values = [
    target.sourcePngArtifactId,
    target.sourcePngUploadId,
    target.sourcePngSha256,
    target.sourcePngByteLength,
    target.sourcePngRegisteredAt,
  ];
  if (values.every((value) => value === null)) return undefined;
  if (
    target.sourcePngArtifactId !== input.sourceArtifactId ||
    target.sourcePngUploadId === null ||
    target.sourcePngSha256?.toUpperCase() !== input.sourceSha256 ||
    target.sourcePngByteLength !== input.sourceByteLength ||
    target.sourcePngRegisteredAt === null
  ) {
    return "conflict";
  }
  return sourceView(input);
}

function sourceView(
  input: RegisterProfessionTargetFrameSourceInput,
): ProfessionTargetFrameSourceView {
  return {
    schemaVersion: 1,
    status: "registered",
    skillId: input.skillId,
    entryIndex: input.entryIndex,
    frameIndex: input.frameIndex,
    sourceArtifactId: input.sourceArtifactId,
    sourceByteLength: input.sourceByteLength,
    sourceSha256: input.sourceSha256,
  };
}

function sourceRead(
  evidence: LockedSourceEvidence,
): ProfessionTargetFrameSourceRead {
  const alpha = evidence.target.sourceAlphaSha256;
  if (!alpha) throw new Error("PROFESSION_TARGET_SOURCE_ALPHA_REQUIRED");
  return {
    targetId: evidence.target.id,
    artifactId: evidence.artifactId,
    uploadId: evidence.uploadId,
    read: evidence.read,
    provenance: evidence.provenance,
    expected: {
      width: evidence.target.width,
      height: evidence.target.height,
      sourceAlphaSha256: alpha,
    },
  };
}

function sameSourceRead(
  current: ProfessionTargetFrameSourceRead,
  inspected: ProfessionTargetFrameSourceRead,
): boolean {
  return stableStringifyJcsV1(current) === stableStringifyJcsV1(inspected);
}
