/**
 * @fileoverview 将 Package V3 context Repository 的有限状态映射为稳定内部 HTTP 错误；
 * 不查询数据库、不签发 Artifact URL，也不执行或启用封包 capability。
 * @module modules/job/style-package-context-service
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 首个纵向协议切片
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  StylePackageContextRepository,
  type ResolveStylePackageContextResult,
} from "./style-package-context.repository.js";
import type {
  RequestStylePackageContextV3,
  StylePackageContextEnvelopeV3,
} from "./style-package-production.contracts.js";

interface StylePackageContextRepositoryPort {
  resolve(
    jobId: string,
    input: RequestStylePackageContextV3,
  ): Promise<ResolveStylePackageContextResult>;
}

/** Package V3 context 业务层，只在全部证据 accepted 时返回信封。 */
@Injectable()
export class StylePackageContextService {
  constructor(
    @Inject(StylePackageContextRepository)
    private readonly contexts: StylePackageContextRepositoryPort,
  ) {}

  /**
   * 读取当前 npk-package attempt 的冻结输入。
   * @param jobId 内部路由已校验的 Job UUID。
   * @param input 当前 claim 的精确 lease，不允许选择技能或 Artifact。
   * @returns 规范 context 与 SHA-256 信封，不含对象定位或本机执行参数。
   */
  async get(
    jobId: string,
    input: RequestStylePackageContextV3,
  ): Promise<StylePackageContextEnvelopeV3> {
    const result = await this.contexts.resolve(jobId, input);
    if (result.status === "accepted") return result.envelope;
    const definition = contextFailureDefinitions[result.status];
    const body = { code: definition.code, message: definition.message };
    if (definition.kind === "not-found") throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}

const contextFailureDefinitions: Record<
  Exclude<ResolveStylePackageContextResult["status"], "accepted">,
  { kind: "conflict" | "not-found"; code: string; message: string }
> = {
  "lease-mismatch": {
    kind: "conflict",
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    kind: "conflict",
    code: "STYLE_PACKAGE_JOB_KIND_REQUIRED",
    message: "只有 npk-package 类型任务可以读取最终封包上下文。",
  },
  "job-integrity-failed": {
    kind: "conflict",
    code: "STYLE_PACKAGE_JOB_INTEGRITY_FAILED",
    message: "最终封包任务的冻结内容完整性校验失败。",
  },
  "package-not-found": {
    kind: "not-found",
    code: "STYLE_PACKAGE_NOT_FOUND",
    message: "主题包计划不存在或已进入终态。",
  },
  "package-evidence-incomplete": {
    kind: "conflict",
    code: "STYLE_PACKAGE_INPUT_EVIDENCE_INCOMPLETE",
    message: "最终封包所需的逐技能证据不完整或已漂移。",
  },
};
