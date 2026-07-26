/**
 * @fileoverview 接收当前 npk-package attempt 的 V3 状态报告并封存三 Artifact 证据；不完成 Job、
 * 不执行封包器、不读取对象正文，也不把 package 聚合直接提升为通过。
 * @module modules/job/style-package-production-repository
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * 调用关系：StylePackageProductionService 在 Worker token 路由校验 DTO 后调用本 Repository；本类先锁定
 * Job，再复用 context 聚合支持层重新生成当前 context，最后写 style_package_attempt_evidences。
 * 输入输出：输入是当前 lease 的 V3 报告 DTO，输出只包含有限 accepted/rejected 状态。副作用：写入或更新
 * attempt 证据；building 可将 style_packages 从 queued 推进到 building。安全边界：passed 报告必须匹配
 * 当前 context/profile 摘要，并且三份 Artifact 必须由当前 Job/Worker/lease/attempt 的 finalized upload
 * session 产生，且 provenance 按 candidate -> manifest -> validation 固定反向绑定。
 */
import { Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { DatabaseService } from "../../common/db/database.service.js";
import { artifacts, jobs } from "../../common/db/schema.js";
import {
  stylePackageAttemptEvidences,
  stylePackages,
} from "../../common/db/style-package-schema.js";
import {
  databaseNow,
  type JobTransaction,
} from "./job-run-event.repository-support.js";
import {
  resolveStylePackageContextInTransaction,
  type ResolveStylePackageContextResult,
} from "./style-package-context.repository-support.js";
import {
  stylePackageArtifactMediaTypesV3,
  stylePackageCandidateArtifactProvenanceV3Schema,
  stylePackageCandidateLogicalNameV3,
  stylePackageManifestArtifactProvenanceV3Schema,
  stylePackageManifestLogicalNameV3,
  stylePackageValidationArtifactProvenanceV3Schema,
  stylePackageValidationLogicalNameV3,
} from "./style-package-artifact-evidence.contracts.js";
import type {
  ReportStylePackageProductionV3,
  RequestStylePackageContextV3,
  StylePackageContextV3,
} from "./style-package-production.contracts.js";

type PassedReport = Extract<
  ReportStylePackageProductionV3,
  { status: "passed" }
>;
type TerminalReport = Extract<
  ReportStylePackageProductionV3,
  { status: "failed" | "blocked" }
>;

/** V3 报告接收的有限结果；Service 负责映射为稳定 HTTP 错误。 */
export type ReportStylePackageProductionResult =
  | Extract<
      ResolveStylePackageContextResult,
      {
        status: Exclude<ResolveStylePackageContextResult["status"], "accepted">;
      }
    >
  | { status: "package-terminal" | "artifact-evidence-mismatch" }
  | { status: "accepted" };

interface OutputArtifactRow {
  id: string;
  runId: string;
  logicalName: string;
  storageKey: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  provenance: unknown;
  uploadId: string;
  uploadObjectKey: string;
  uploadLogicalName: string;
  uploadMediaType: string;
  expectedByteLength: number;
  expectedSha256: string;
  uploadProvenance: unknown;
  finalizedAt: Date | null;
  objectDeletedAt: Date | null;
}

/** Package V3 报告的持久化边界，拥有当前 Job attempt 与最终输出证据的行锁事务。 */
@Injectable()
export class StylePackageProductionRepository {
  /** @param connection 应用共享 Drizzle 连接；Controller/Service 不直接拼接数据库查询。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 接收一个当前 npk-package attempt 的状态报告。
   *
   * @param jobId Worker 内部路由中已经过 UUID 校验的 Job id。
   * @param input 当前 Worker/lease/attempt 的 V3 报告 DTO；不能选择 Run、package 行或对象 key。
   * @returns accepted 表示报告已封存；不代表通用 Job complete 已执行或 Run 已通过。
   */
  async report(
    jobId: string,
    input: ReportStylePackageProductionV3,
  ): Promise<ReportStylePackageProductionResult> {
    return this.connection.database.transaction(async (transaction) => {
      // 第一步：锁定 Job 并用同一事务复算 context，防止报告使用旧 context 摘要。
      const [job] = await transaction
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for("update");
      if (!job) return { status: "lease-mismatch" };
      const now = await databaseNow(transaction);
      const lease: RequestStylePackageContextV3 = {
        workerId: input.workerId,
        leaseId: input.leaseId,
        attempt: input.attempt,
      };
      const context = await resolveStylePackageContextInTransaction(
        transaction,
        job,
        lease,
        now,
      );
      if (context.status !== "accepted") return context;
      if (
        context.envelope.contextSha256 !==
          input.packageContextSha256.toUpperCase() ||
        context.envelope.context.packageProfileSha256 !==
          input.packageProfileSha256.toUpperCase()
      ) {
        return { status: "job-integrity-failed" };
      }

      // 第二步：锁定当前 attempt evidence；已终态不可由重试请求覆盖，避免更换 Artifact 或错误码。
      const [existing] = await transaction
        .select()
        .from(stylePackageAttemptEvidences)
        .where(
          and(
            eq(stylePackageAttemptEvidences.jobId, jobId),
            eq(stylePackageAttemptEvidences.attempt, input.attempt),
          ),
        )
        .limit(1)
        .for("update");
      if (existing && existing.status !== "building") {
        return { status: "package-terminal" };
      }

      if (input.status !== "passed") {
        await upsertNonPassedAttempt(
          transaction,
          existing?.id,
          job,
          context.envelope.context,
          input,
          now,
        );
        if (input.status === "building") {
          await transaction
            .update(stylePackages)
            .set({ status: "building", updatedAt: now })
            .where(
              and(
                eq(stylePackages.runId, job.runId),
                eq(stylePackages.status, "queued"),
              ),
            );
          return { status: "accepted" };
        }
        await transaction
          .update(stylePackages)
          .set({ status: input.status, updatedAt: now, finishedAt: now })
          .where(eq(stylePackages.runId, job.runId));
        return { status: "accepted" };
      }

      const evidence = await resolvePassedOutputEvidence(
        transaction,
        job.runId,
        jobId,
        context.envelope.context,
        input,
      );
      if (!evidence) return { status: "artifact-evidence-mismatch" };
      await upsertPassedAttempt(
        transaction,
        existing?.id,
        job,
        context.envelope.context,
        input,
        evidence,
        now,
      );
      return { status: "accepted" };
    });
  }
}

async function upsertNonPassedAttempt(
  transaction: JobTransaction,
  existingId: string | undefined,
  job: typeof jobs.$inferSelect,
  context: StylePackageContextV3,
  input:
    | Extract<ReportStylePackageProductionV3, { status: "building" }>
    | TerminalReport,
  now: Date,
): Promise<void> {
  const values = {
    runId: job.runId,
    stylePackageId: await resolveStylePackageId(transaction, job.runId),
    jobId: job.id,
    workerId: input.workerId,
    leaseId: input.leaseId,
    attempt: input.attempt,
    status: input.status,
    packageContextSha256: input.packageContextSha256.toUpperCase(),
    packageProfileSha256: input.packageProfileSha256.toUpperCase(),
    safety: context.safety,
    errorCode: "errorCode" in input ? input.errorCode : null,
    updatedAt: now,
    finishedAt: input.status === "building" ? null : now,
  };
  if (existingId) {
    await transaction
      .update(stylePackageAttemptEvidences)
      .set(values)
      .where(eq(stylePackageAttemptEvidences.id, existingId));
    return;
  }
  await transaction.insert(stylePackageAttemptEvidences).values({
    id: randomUUID(),
    ...values,
    createdAt: now,
  });
}

async function upsertPassedAttempt(
  transaction: JobTransaction,
  existingId: string | undefined,
  job: typeof jobs.$inferSelect,
  context: StylePackageContextV3,
  input: PassedReport,
  evidence: {
    packageUploadId: string;
    manifestUploadId: string;
    validationUploadId: string;
  },
  now: Date,
): Promise<void> {
  const values = {
    runId: job.runId,
    stylePackageId: await resolveStylePackageId(transaction, job.runId),
    jobId: job.id,
    workerId: input.workerId,
    leaseId: input.leaseId,
    attempt: input.attempt,
    status: "passed" as const,
    packageContextSha256: input.packageContextSha256.toUpperCase(),
    packageProfileSha256: input.packageProfileSha256.toUpperCase(),
    packageArtifactId: input.packageArtifactId,
    packageSha256: input.packageSha256.toUpperCase(),
    packageUploadId: evidence.packageUploadId,
    manifestArtifactId: input.manifestArtifactId,
    manifestSha256: input.manifestSha256.toUpperCase(),
    manifestUploadId: evidence.manifestUploadId,
    validationArtifactId: input.validationArtifactId,
    validationSha256: input.validationSha256.toUpperCase(),
    validationUploadId: evidence.validationUploadId,
    safety: input.safety,
    errorCode: null,
    updatedAt: now,
    finishedAt: now,
  };
  if (existingId) {
    await transaction
      .update(stylePackageAttemptEvidences)
      .set(values)
      .where(eq(stylePackageAttemptEvidences.id, existingId));
    return;
  }
  await transaction.insert(stylePackageAttemptEvidences).values({
    id: randomUUID(),
    ...values,
    createdAt: now,
  });
}

async function resolveStylePackageId(
  transaction: JobTransaction,
  runId: string,
): Promise<string> {
  const [pack] = await transaction
    .select({ id: stylePackages.id })
    .from(stylePackages)
    .where(eq(stylePackages.runId, runId))
    .limit(1);
  if (!pack) throw new Error("STYLE_PACKAGE_INVARIANT_FAILED");
  return pack.id;
}

async function resolvePassedOutputEvidence(
  transaction: JobTransaction,
  runId: string,
  jobId: string,
  context: StylePackageContextV3,
  report: PassedReport,
): Promise<
  | {
      packageUploadId: string;
      manifestUploadId: string;
      validationUploadId: string;
    }
  | undefined
> {
  const rows = await transaction
    .select({
      id: artifacts.id,
      runId: artifacts.runId,
      logicalName: artifacts.logicalName,
      storageKey: artifacts.storageKey,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
      provenance: artifacts.provenance,
      uploadId: artifactUploadSessions.id,
      uploadObjectKey: artifactUploadSessions.objectKey,
      uploadLogicalName: artifactUploadSessions.logicalName,
      uploadMediaType: artifactUploadSessions.mediaType,
      expectedByteLength: artifactUploadSessions.expectedByteLength,
      expectedSha256: artifactUploadSessions.expectedSha256,
      uploadProvenance: artifactUploadSessions.provenance,
      finalizedAt: artifactUploadSessions.finalizedAt,
      objectDeletedAt: artifactUploadSessions.objectDeletedAt,
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
        eq(artifactUploadSessions.runId, runId),
        eq(artifactUploadSessions.jobId, jobId),
        eq(artifactUploadSessions.workerId, report.workerId),
        eq(artifactUploadSessions.leaseId, report.leaseId),
        eq(artifactUploadSessions.attempt, report.attempt),
        eq(artifactUploadSessions.status, "finalized"),
        inArray(artifactUploadSessions.artifactId, [
          report.packageArtifactId,
          report.manifestArtifactId,
          report.validationArtifactId,
        ]),
      ),
    )
    .for("update");
  const candidate = rows.find((row) => row.id === report.packageArtifactId);
  const manifest = rows.find((row) => row.id === report.manifestArtifactId);
  const validation = rows.find((row) => row.id === report.validationArtifactId);
  if (
    !matchesOutputRow(candidate, context, report, "candidate") ||
    !matchesOutputRow(manifest, context, report, "manifest") ||
    !matchesOutputRow(validation, context, report, "validation")
  ) {
    return undefined;
  }
  return {
    packageUploadId: candidate.uploadId,
    manifestUploadId: manifest.uploadId,
    validationUploadId: validation.uploadId,
  };
}

function matchesOutputRow(
  row: OutputArtifactRow | undefined,
  context: StylePackageContextV3,
  report: PassedReport,
  role: "candidate" | "manifest" | "validation",
): row is OutputArtifactRow {
  if (
    !row ||
    row.runId !== context.runId ||
    row.finalizedAt === null ||
    row.objectDeletedAt !== null
  ) {
    return false;
  }
  if (
    row.uploadObjectKey !== row.storageKey ||
    row.uploadLogicalName !== row.logicalName ||
    row.uploadMediaType !== row.mediaType ||
    row.expectedByteLength !== row.byteLength ||
    row.expectedSha256.toUpperCase() !== row.sha256.toUpperCase()
  ) {
    return false;
  }
  if (role === "candidate") {
    const provenance =
      stylePackageCandidateArtifactProvenanceV3Schema.safeParse(row.provenance);
    return (
      provenance.success &&
      isDeepStrictEqual(provenance.data, row.uploadProvenance) &&
      matchesBaseProvenance(provenance.data, context, report) &&
      row.logicalName === stylePackageCandidateLogicalNameV3 &&
      row.mediaType === context.packageProfile.outputMediaType &&
      row.sha256.toUpperCase() === report.packageSha256.toUpperCase()
    );
  }
  if (role === "manifest") {
    const provenance = stylePackageManifestArtifactProvenanceV3Schema.safeParse(
      row.provenance,
    );
    return (
      provenance.success &&
      isDeepStrictEqual(provenance.data, row.uploadProvenance) &&
      matchesBaseProvenance(provenance.data, context, report) &&
      row.logicalName === stylePackageManifestLogicalNameV3 &&
      row.mediaType === stylePackageArtifactMediaTypesV3.manifest &&
      row.sha256.toUpperCase() === report.manifestSha256.toUpperCase() &&
      provenance.data.package.artifactId === report.packageArtifactId &&
      provenance.data.package.sha256.toUpperCase() ===
        report.packageSha256.toUpperCase()
    );
  }
  const provenance = stylePackageValidationArtifactProvenanceV3Schema.safeParse(
    row.provenance,
  );
  return (
    provenance.success &&
    isDeepStrictEqual(provenance.data, row.uploadProvenance) &&
    matchesBaseProvenance(provenance.data, context, report) &&
    row.logicalName === stylePackageValidationLogicalNameV3 &&
    row.mediaType === stylePackageArtifactMediaTypesV3.validation &&
    row.sha256.toUpperCase() === report.validationSha256.toUpperCase() &&
    provenance.data.package.artifactId === report.packageArtifactId &&
    provenance.data.package.sha256.toUpperCase() ===
      report.packageSha256.toUpperCase() &&
    provenance.data.manifest.artifactId === report.manifestArtifactId &&
    provenance.data.manifest.sha256.toUpperCase() ===
      report.manifestSha256.toUpperCase()
  );
}

function matchesBaseProvenance(
  provenance: {
    jobId: string;
    attempt: number;
    packageContextSha256: string;
    packageProfileSha256: string;
    safety: StylePackageContextV3["safety"];
  },
  context: StylePackageContextV3,
  report: PassedReport,
): boolean {
  return (
    provenance.jobId === context.jobId &&
    provenance.attempt === report.attempt &&
    provenance.packageContextSha256.toUpperCase() ===
      report.packageContextSha256.toUpperCase() &&
    provenance.packageProfileSha256.toUpperCase() ===
      report.packageProfileSha256.toUpperCase() &&
    isDeepStrictEqual(provenance.safety, context.safety) &&
    isDeepStrictEqual(report.safety, context.safety)
  );
}
