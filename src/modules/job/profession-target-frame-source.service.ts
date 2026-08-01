/**
 * @fileoverview 编排 Profession V6 官方逐帧 PNG 的对象复读、Alpha/尺寸验证和 target 行登记；
 * 不调用图片模型、不执行本机工具，也不改变 Job 或 production 终态。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - V6 逐帧模型输入冻结
 *
 * 调用关系：内部 Worker Controller 校验 DTO 后调用本 Service；本层先调用 Repository inspect，
 * 必要时在无数据库锁阶段读取 finalized PNG，交给 source-image 校验器，再调用 commit。
 * 输出是可供后续模型执行消费的单帧输入回执；对象正文不会进入数据库或响应。
 * 安全边界：Repository 返回的 object key 是唯一可用读取声明；Artifact 长度/SHA、PNG 真实尺寸和
 * Alpha 必须共同通过。任何失败都不写 target 行，registered 不代表模型已调用或目标图已生成。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ObjectStoragePort } from "../../common/storage/object-storage.client.js";
import { OBJECT_STORAGE_PORT } from "../../common/storage/object-storage.tokens.js";
import type {
  RegisterProfessionTargetFrameSourceInput,
  ProfessionTargetFrameSourceView,
} from "./profession-target-frame-prepare.contracts.js";
import {
  ProfessionTargetFrameSourceRepository,
  type CommitProfessionTargetFrameSourceResult,
  type InspectProfessionTargetFrameSourceResult,
  type ProfessionTargetFrameSourceFailure,
} from "./profession-target-frame-source.repository.js";
import {
  ProfessionTargetFrameSourceImageError,
  verifyProfessionTargetFrameSourceImage,
} from "./profession-target-frame-source-image.js";

interface SourceRepositoryPort {
  inspect(
    jobId: string,
    input: RegisterProfessionTargetFrameSourceInput,
  ): Promise<InspectProfessionTargetFrameSourceResult>;
  commit(
    jobId: string,
    input: RegisterProfessionTargetFrameSourceInput,
    inspected: Parameters<ProfessionTargetFrameSourceRepository["commit"]>[2],
  ): Promise<CommitProfessionTargetFrameSourceResult>;
}

@Injectable()
/** V6 单帧官方输入登记业务层，拥有对象复读顺序和错误边界。 */
export class ProfessionTargetFrameSourceService {
  constructor(
    @Inject(ProfessionTargetFrameSourceRepository)
    private readonly sources: SourceRepositoryPort,
    @Inject(OBJECT_STORAGE_PORT) private readonly storage: ObjectStoragePort,
  ) {}

  /**
   * 登记当前 attempt 的一帧官方 source PNG。
   * @param jobId 内部路由 path 中已通过 UUID 校验的 Profession Job。
   * @param input Worker body 中已通过严格 schema 的 lease、帧身份和 finalized Artifact 声明。
   * @returns 首次登记或同证据重报的脱敏回执；不证明图片模型、目标图或 Aseprite 已执行。
   * @throws ConflictException 当 target、Artifact、几何或 Alpha 证据不匹配；503 仅表示对象读取暂时不可用。
   */
  async register(
    jobId: string,
    input: RegisterProfessionTargetFrameSourceInput,
  ): Promise<ProfessionTargetFrameSourceView> {
    const inspected = await this.sources.inspect(jobId, input);
    if (inspected.status === "registered") return inspected.source;
    if (inspected.status !== "read-required") {
      throwSourceFailure(inspected);
    }
    let stored: Awaited<ReturnType<ObjectStoragePort["readVerifiedBytes"]>>;
    try {
      stored = await this.storage.readVerifiedBytes(inspected.read.read);
    } catch {
      throw new ServiceUnavailableException({
        code: "PROFESSION_TARGET_FRAME_STORAGE_UNAVAILABLE",
        message: "官方逐帧 PNG 暂时无法完成完整性复读。",
      });
    }
    if (
      stored.mediaType !== "image/png" ||
      stored.byteLength !== input.sourceByteLength ||
      stored.sha256.toUpperCase() !== input.sourceSha256
    ) {
      throw new ConflictException({
        code: "PROFESSION_TARGET_FRAME_SOURCE_ARTIFACT_MISMATCH",
        message: "官方逐帧 PNG Artifact 证据与声明不一致。",
      });
    }
    try {
      await verifyProfessionTargetFrameSourceImage(
        stored.bytes,
        inspected.read.expected,
      );
    } catch (error) {
      if (error instanceof ProfessionTargetFrameSourceImageError) {
        throw new ConflictException({
          code: error.code,
          message: "官方逐帧 PNG 的尺寸或 Alpha 证据不可信。",
        });
      }
      throw error;
    }
    const committed = await this.sources.commit(jobId, input, inspected.read);
    if (committed.status === "registered") return committed.source;
    return throwSourceFailure(committed);
  }
}

type SourceFailureStatus = ProfessionTargetFrameSourceFailure["status"];

const sourceFailureDefinitions: Record<
  SourceFailureStatus,
  { code: string; message: string }
> = {
  "lease-mismatch": {
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    code: "PATCH_TASK_JOB_KIND_REQUIRED",
    message: "只有 profession 类型任务可以登记逐帧输入。",
  },
  "job-integrity-failed": {
    code: "PROFESSION_JOB_INTEGRITY_FAILED",
    message: "职业制作任务的冻结内容完整性校验失败。",
  },
  "skill-not-found": {
    code: "PROFESSION_JOB_SKILL_NOT_FOUND",
    message: "请求的技能不在职业制作任务的冻结技能集合中。",
  },
  "job-contract-mismatch": {
    code: "PROFESSION_TARGET_FRAME_CONTRACT_REQUIRED",
    message: "当前职业制作任务不支持同尺寸逐帧输入。",
  },
  "target-frame-not-found": {
    code: "PROFESSION_TARGET_FRAME_NOT_FOUND",
    message: "请求的逐帧 target 尚未准备或不属于当前任务轮次。",
  },
  "target-frame-policy-mismatch": {
    code: "PROFESSION_TARGET_FRAME_POLICY_MISMATCH",
    message: "只有可生成的可见 target 帧允许登记官方输入。",
  },
  "source-artifact-mismatch": {
    code: "PROFESSION_TARGET_FRAME_SOURCE_ARTIFACT_MISMATCH",
    message: "官方逐帧 PNG Artifact 未由当前任务轮次完整上传。",
  },
  "source-registration-conflict": {
    code: "PROFESSION_TARGET_FRAME_SOURCE_REGISTRATION_CONFLICT",
    message: "逐帧官方输入已被不同证据登记，不能覆盖。",
  },
};

function throwSourceFailure(
  failure: ProfessionTargetFrameSourceFailure,
): never {
  const definition = sourceFailureDefinitions[failure.status];
  throw new ConflictException(definition);
}
