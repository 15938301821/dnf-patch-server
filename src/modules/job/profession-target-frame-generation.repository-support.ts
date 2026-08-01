/**
 * @fileoverview 为 Profession V6 单帧生成 Repository 提供固定锁序、源 Artifact 解析和数据库状态
 * 投影；不调用模型、不写对象正文，也不执行目标状态更新或 HTTP 异常映射。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：Generation Repository 的每个短事务调用本文件，先锁 Job 再锁 target，并从同 Run
 * Artifact 恢复受控源 PNG 读取声明。输入是 Controller 已校验的当前 lease 与帧坐标，输出是锁内
 * 领域上下文、有限拒绝状态或脱敏状态投影。副作用：查询在调用方 transaction 内取得 row lock；
 * 本文件不提交事务、不更新状态。安全边界：数据库时间、V6合同、lease fencing、帧策略、源摘要
 * 和对象归属任一不一致都 fail-closed；reserved/egressing 只投影为 in-progress，不能授予新出站权。
 */
import { and, eq } from "drizzle-orm";
import { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import { artifacts, jobs } from "../../common/db/schema.js";
import {
  databaseNow,
  type JobTransaction,
} from "./job-run-event.repository-support.js";
import {
  resolveProfessionExecutionContext,
  type FrozenProfessionSkillExecutionContext,
} from "./profession-execution-context.js";
import {
  professionTargetFrameNormalizationAlgorithm,
  type GenerateProfessionTargetFrameInput,
  type ProfessionTargetFrameGenerationView,
} from "./profession-target-frame-generation.contracts.js";
import type {
  ProfessionTargetFrameGenerationContext,
  ProfessionTargetFrameGenerationFailure,
} from "./profession-target-frame-generation.js";

type TargetRow = typeof professionSkillFrameTargets.$inferSelect;

/** Repository命令在锁内消费的Job、数据库时间、冻结上下文和目标行。 */
export interface LockedProfessionTargetFrameGeneration {
  job: typeof jobs.$inferSelect;
  now: Date;
  context: FrozenProfessionSkillExecutionContext;
  target: TargetRow;
}

/** 锁定入口返回有限失败或完整锁内事实，调用方不得跳过status判别。 */
export type LockProfessionTargetFrameGenerationResult =
  | ProfessionTargetFrameGenerationFailure
  | ({ status: "ready" } & LockedProfessionTargetFrameGeneration);

/**
 * 固定按 Job -> target 顺序锁定当前V6帧。
 * @param transaction 调用方短事务；任一后续写入失败会由该事务整体回滚。
 * @param jobId 内部路由已校验的当前Profession Job UUID。
 * @param input 当前Worker、leaseId、attempt、技能和帧坐标，必须精确匹配数据库事实。
 * @returns ready或有限拒绝状态；ready仍不代表模型已获准出站。
 */
export async function lockProfessionTargetFrameGeneration(
  transaction: JobTransaction,
  jobId: string,
  input: GenerateProfessionTargetFrameInput,
): Promise<LockProfessionTargetFrameGenerationResult> {
  // Job 是租约和Run的权威记录；先锁它可阻止旧attempt与reaper并发改变执行权。
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

  // target 行是单帧状态的权威记录；唯一键与行锁共同串行化同一帧的inspect/reserve/finalize。
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
  if (!validGenerationTarget(job, input, target)) {
    return { status: "target-frame-integrity-failed" };
  }
  return { status: "ready", job, now, context: gate.context, target };
}

/** 复用相同Job -> target锁序，并要求服务内部targetId与HTTP帧坐标仍指向同一行。 */
export async function lockProfessionTargetFrameGenerationById(
  transaction: JobTransaction,
  jobId: string,
  targetId: string,
  input: GenerateProfessionTargetFrameInput,
): Promise<LockedProfessionTargetFrameGeneration | undefined> {
  const locked = await lockProfessionTargetFrameGeneration(
    transaction,
    jobId,
    input,
  );
  return locked.status === "ready" && locked.target.id === targetId
    ? locked
    : undefined;
}

/**
 * 从已登记源Artifact恢复唯一允许在事务外读取的对象声明。
 * @returns 完整上下文；缺少源登记或Artifact摘要漂移时返回undefined，调用方映射为source-not-ready。
 */
export async function resolveProfessionTargetFrameGenerationContext(
  transaction: JobTransaction,
  locked: LockedProfessionTargetFrameGeneration,
): Promise<ProfessionTargetFrameGenerationContext | undefined> {
  const target = locked.target;
  if (
    !target.sourcePngArtifactId ||
    !target.sourcePngSha256 ||
    !target.sourcePngByteLength ||
    !target.sourceAlphaSha256 ||
    !target.sourcePngRegisteredAt
  ) {
    return undefined;
  }
  const [source] = await transaction
    .select({
      storageKey: artifacts.storageKey,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, locked.job.runId),
        eq(artifacts.id, target.sourcePngArtifactId),
      ),
    )
    .limit(1);
  if (
    !source ||
    source.mediaType !== "image/png" ||
    source.byteLength !== target.sourcePngByteLength ||
    source.sha256.toUpperCase() !== target.sourcePngSha256.toUpperCase()
  ) {
    return undefined;
  }
  return {
    targetId: target.id,
    runId: locked.job.runId,
    context: locked.context,
    sourceImage: {
      artifactId: target.sourcePngArtifactId,
      objectKey: source.storageKey,
      expectedMediaType: "image/png",
      expectedByteLength: source.byteLength,
      expectedSha256: source.sha256.toUpperCase(),
      maxByteLength: 64 * 1024 * 1024,
    },
    target: {
      entryIndex: target.entryIndex,
      frameIndex: target.frameIndex,
      width: target.width,
      height: target.height,
      sourceSha256: target.sourcePngSha256.toUpperCase(),
      sourceAlphaSha256: target.sourceAlphaSha256.toUpperCase(),
    },
  };
}

/** 把数据库行投影为新建、恢复、Worker ViewModel或完整性失败，不修改任何状态。 */
export function classifyProfessionTargetFrameGeneration(
  target: TargetRow,
  input: GenerateProfessionTargetFrameInput,
):
  | { status: "new" }
  | {
      status: "persistence-pending";
      modelCallId: string;
      outputSha256: string;
      outputByteLength: number;
    }
  | ProfessionTargetFrameGenerationView
  | ProfessionTargetFrameGenerationFailure {
  const identity = {
    schemaVersion: 1 as const,
    skillId: input.skillId,
    entryIndex: input.entryIndex,
    frameIndex: input.frameIndex,
  };
  if (target.generationStatus === null) return { status: "new" };
  if (
    target.generationStatus === "reserved" ||
    target.generationStatus === "egressing"
  ) {
    return { ...identity, status: "in-progress" };
  }
  if (target.generationStatus === "persisting") {
    if (
      !target.generationModelCallId ||
      !target.targetPngSha256 ||
      !target.targetPngByteLength ||
      target.targetNormalizationAlgorithm !==
        professionTargetFrameNormalizationAlgorithm
    ) {
      return { status: "target-frame-integrity-failed" };
    }
    return {
      status: "persistence-pending",
      modelCallId: target.generationModelCallId,
      outputSha256: target.targetPngSha256.toUpperCase(),
      outputByteLength: target.targetPngByteLength,
    };
  }
  if (target.generationStatus === "blocked") {
    return target.generationErrorCode
      ? {
          ...identity,
          status: "blocked",
          errorCode: target.generationErrorCode,
        }
      : { status: "target-frame-integrity-failed" };
  }
  if (
    target.generationStatus === "passed" &&
    target.generationModelCallId &&
    target.generationImageAttemptId &&
    target.targetPngArtifactId &&
    target.targetPngSha256 &&
    target.targetPngByteLength &&
    target.sourceAlphaSha256 &&
    target.targetNormalizationAlgorithm ===
      professionTargetFrameNormalizationAlgorithm
  ) {
    return {
      ...identity,
      status: "passed",
      modelCallId: target.generationModelCallId,
      imageAttemptId: target.generationImageAttemptId,
      targetArtifactId: target.targetPngArtifactId,
      mediaType: "image/png",
      width: target.width,
      height: target.height,
      byteLength: target.targetPngByteLength,
      sha256: target.targetPngSha256.toUpperCase(),
      sourceAlphaSha256: target.sourceAlphaSha256.toUpperCase(),
      normalizationAlgorithm: professionTargetFrameNormalizationAlgorithm,
    };
  }
  return { status: "target-frame-integrity-failed" };
}

/** 把MySQL SUM结果转成安全非负整数；异常数据不能静默放宽Run配额。 */
export function professionTargetFrameNumericTotal(
  value: string | number | undefined,
): number {
  const total = Number(value ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("ARTIFACT_QUOTA_TOTAL_INVALID");
  }
  return total;
}

function validGenerationTarget(
  job: typeof jobs.$inferSelect,
  input: GenerateProfessionTargetFrameInput,
  target: TargetRow,
): boolean {
  return (
    target.runId === job.runId &&
    target.workerId === input.workerId &&
    target.leaseId === input.leaseId &&
    target.targetPolicy === "generate-same-size" &&
    !target.hidden &&
    target.generationOrdinal !== null &&
    target.sourceDecodedBgraSha256 !== null &&
    target.sourceAlphaSha256 !== null &&
    target.width > 0 &&
    target.height > 0
  );
}
