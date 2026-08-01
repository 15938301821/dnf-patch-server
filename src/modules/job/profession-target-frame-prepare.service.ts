/**
 * @fileoverview 编排 Profession V6 target-frame manifest 的事务外复读、严格解析与逐帧绑定；
 * 不直接查询数据库、不调用图片模型、不执行本机工具，也不改变 Job 或 production 终态。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：内部 Worker Controller 完成 token 和 DTO 校验后调用本 Service；本层先调用 Repository
 * 的 inspect 短事务，必要时通过 ObjectStoragePort 在无数据库锁阶段复读 source/target 两份私有对象，
 * 再调用 commit 短事务写入逐帧事实。输入是 exact lease 与 finalized manifest Artifact 声明，输出是
 * 不含对象 key、数据库行 ID、Prompt 或模型配置的 prepared ViewModel。
 * 副作用：最多读取两份有界对象并触发一次逐帧批量写入；对象读取失败或正文不可信时不调用 commit。
 * 安全边界：对象 key 只能来自 Repository 已复核的数据库证据；source 使用历史 JSON.stringify 编码，
 * target 使用 JCS 编码，且每一帧必须与 payload 冻结的官方 source 身份一致。任何缺失或漂移均
 * fail-closed，prepared 只表示逐帧计划已冻结，不表示模型已出站、目标图已生成或补丁可部署。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ObjectStoragePort } from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import type {
  PrepareProfessionTargetFramesInput,
  ProfessionTargetFramePreparationView,
} from "./profession-target-frame-prepare.contracts.js";
import {
  ProfessionTargetFramePrepareRepository,
  type CommitProfessionTargetFramesResult,
  type InspectProfessionTargetFramesResult,
  type ProfessionTargetFramePreparationFailure,
} from "./profession-target-frame-prepare.repository.js";
import {
  parseProfessionSourceFrameManifestBytes,
  ProfessionSourceFrameManifestError,
} from "./profession-source-frame-manifest.js";
import {
  assertProfessionTargetFrameManifestMatchesSource,
  parseProfessionTargetFrameManifestBytes,
  ProfessionTargetFrameManifestError,
} from "./profession-target-frame-manifest.js";

interface ProfessionTargetFramePrepareRepositoryPort {
  inspect(
    jobId: string,
    input: PrepareProfessionTargetFramesInput,
  ): Promise<InspectProfessionTargetFramesResult>;
  commit(
    jobId: string,
    input: PrepareProfessionTargetFramesInput,
    manifest: Parameters<ProfessionTargetFramePrepareRepository["commit"]>[2],
    inspected: Parameters<ProfessionTargetFramePrepareRepository["commit"]>[3],
  ): Promise<CommitProfessionTargetFramesResult>;
}

@Injectable()
/** V6 逐帧准备业务层，拥有事务外对象复读顺序和稳定失败映射。 */
export class ProfessionTargetFramePrepareService {
  /**
   * @param preparations 拥有 Job/lease/Artifact 行锁和逐帧事务写入的 Repository 边界。
   * @param storage 只按数据库冻结声明完整复核小型私有对象的基础设施端口。
   */
  constructor(
    @Inject(ProfessionTargetFramePrepareRepository)
    private readonly preparations: ProfessionTargetFramePrepareRepositoryPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  /**
   * 冻结当前技能在本 attempt 中的官方同尺寸逐帧目标计划。
   * @param jobId 内部路由 path 已通过 UUID schema 校验的 Profession Job 标识。
   * @param input body 中当前 Worker exact lease 与 finalized manifest Artifact 声明。
   * @returns 首次写入或完整同一 manifest 重报时的脱敏 prepared 回执。
   * @throws JOB_LEASE_MISMATCH 等稳定冲突、manifest 无效冲突或对象存储暂时不可用错误。
   */
  async prepare(
    jobId: string,
    input: PrepareProfessionTargetFramesInput,
  ): Promise<ProfessionTargetFramePreparationView> {
    // 步骤 1：短事务只冻结数据库证据；完整已有行可直接幂等返回，不再读取对象。
    const inspected = await this.preparations.inspect(jobId, input);
    if (inspected.status === "prepared") return inspected.preparation;
    if (inspected.status !== "read-required") {
      throwPreparationFailure(inspected);
    }

    // 步骤 2：数据库锁已释放后并行读取两份有界对象；Provider 失败不得进入提交事务。
    let targetBytes: Uint8Array;
    let sourceBytes: Uint8Array;
    try {
      const [target, source] = await Promise.all([
        this.storage.readVerifiedBytes(inspected.read.target),
        this.storage.readVerifiedBytes(inspected.read.source),
      ]);
      targetBytes = target.bytes;
      sourceBytes = source.bytes;
    } catch {
      throw new ServiceUnavailableException({
        code: "PROFESSION_TARGET_FRAME_STORAGE_UNAVAILABLE",
        message: "逐帧清单对象暂时无法完成完整性复核。",
      });
    }

    // 步骤 3：分别按历史 source 编码和当前 target JCS 编码解析，再逐帧绑定官方事实。
    const provenance = inspected.read.targetProvenance;
    try {
      const source = parseProfessionSourceFrameManifestBytes({
        bytes: sourceBytes,
        expectedSha256: inspected.read.source.expectedSha256,
        expectedSourceSha256: provenance.sourceSha256,
        expectedSourceByteLength: inspected.read.sourceByteLength,
        expectedToolSha256: inspected.read.sourceToolSha256,
      });
      const target = parseProfessionTargetFrameManifestBytes({
        bytes: targetBytes,
        expectedSha256: inspected.read.target.expectedSha256,
        expectedSourceSha256: provenance.sourceSha256,
        expectedSourceFrameManifestSha256: provenance.sourceFrameManifestSha256,
      });
      assertProfessionTargetFrameManifestMatchesSource(
        target,
        source,
        inspected.read.frozenEntries,
      );

      // 步骤 4：第二次短事务重新取得相同证据快照；并发漂移或部分写入必须拒绝。
      const committed = await this.preparations.commit(
        jobId,
        input,
        target,
        inspected.read,
      );
      if (committed.status === "prepared") return committed.preparation;
      return throwPreparationFailure(committed);
    } catch (error) {
      if (error instanceof ProfessionSourceFrameManifestError) {
        throw new ConflictException({
          code: error.code,
          message: "官方 source 逐帧清单正文不可信。",
        });
      }
      if (error instanceof ProfessionTargetFrameManifestError) {
        throw new ConflictException({
          code: error.code,
          message: "目标逐帧清单与官方 source 事实不一致。",
        });
      }
      throw error;
    }
  }
}

type PreparationFailureStatus =
  ProfessionTargetFramePreparationFailure["status"];

const preparationFailureDefinitions: Record<
  PreparationFailureStatus,
  { kind: "conflict" | "not-found"; code: string; message: string }
> = {
  "lease-mismatch": {
    kind: "conflict",
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    kind: "conflict",
    code: "PATCH_TASK_JOB_KIND_REQUIRED",
    message: "只有 profession 类型任务可以准备逐帧目标。",
  },
  "job-integrity-failed": {
    kind: "conflict",
    code: "PROFESSION_JOB_INTEGRITY_FAILED",
    message: "职业制作任务的冻结内容完整性校验失败。",
  },
  "skill-not-found": {
    kind: "not-found",
    code: "PROFESSION_JOB_SKILL_NOT_FOUND",
    message: "请求的技能不在职业制作任务的冻结技能集合中。",
  },
  "job-contract-mismatch": {
    kind: "conflict",
    code: "PROFESSION_TARGET_FRAME_CONTRACT_REQUIRED",
    message: "当前职业制作任务不支持同尺寸逐帧目标。",
  },
  "skill-production-evidence-mismatch": {
    kind: "conflict",
    code: "PROFESSION_SKILL_PRODUCTION_EVIDENCE_MISMATCH",
    message: "技能生产计划不存在、已进入终态或来源证据已漂移。",
  },
  "manifest-evidence-mismatch": {
    kind: "conflict",
    code: "PROFESSION_TARGET_FRAME_MANIFEST_EVIDENCE_MISMATCH",
    message: "目标逐帧清单未由当前任务轮次完整上传。",
  },
  "source-evidence-mismatch": {
    kind: "conflict",
    code: "PROFESSION_SOURCE_EVIDENCE_MISMATCH",
    message: "职业制作任务的冻结资源证据不完整或已漂移。",
  },
  "preparation-conflict": {
    kind: "conflict",
    code: "PROFESSION_TARGET_FRAME_PREPARATION_CONFLICT",
    message: "逐帧目标已被不同证据准备，或已有记录不完整。",
  },
};

/** 把 Repository 判别联合映射为稳定 HTTP 错误，不泄露表名、对象 key 或 provenance。 */
function throwPreparationFailure(
  failure: ProfessionTargetFramePreparationFailure,
): never {
  const definition = preparationFailureDefinitions[failure.status];
  const body = { code: definition.code, message: definition.message };
  if (definition.kind === "not-found") throw new NotFoundException(body);
  throw new ConflictException(body);
}
