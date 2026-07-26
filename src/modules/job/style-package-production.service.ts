/**
 * @fileoverview 将 Package V3 报告 Repository 的有限状态映射为稳定 Worker HTTP 错误；不查询数据库、
 * 不完成 Job，也不注册或推断 `npk-package` capability。
 * @module modules/job/style-package-production-service
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * 调用关系：StylePackageProductionController 解析 DTO 后调用本 Service；本 Service 委托 Repository
 * 执行 transaction、row lock、context 复算和 Artifact 证据封存。输入输出：输入是当前 lease 的
 * V3 报告 DTO，输出为空 accepted 语义。副作用：只发生在 Repository 中。安全边界：HTTP 鉴权成功
 * 不替代 lease、attempt、context SHA 和三 Artifact provenance 校验；所有拒绝都使用稳定错误码。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  StylePackageProductionRepository,
  type ReportStylePackageProductionResult,
} from "./style-package-production.repository.js";
import type { ReportStylePackageProductionV3 } from "./style-package-production.contracts.js";

/** Package V3 报告业务层，只在 Repository 完整接受时返回。 */
@Injectable()
export class StylePackageProductionService {
  /** @param productions 持久化当前 attempt 报告和输出 Artifact 证据的 Repository。 */
  constructor(private readonly productions: StylePackageProductionRepository) {}

  /**
   * 封存当前 npk-package attempt 的状态报告。
   * @param jobId 内部路由已校验的 Job UUID。
   * @param input 已通过 V3 schema 校验的 Worker 报告，不含对象 key 或本机路径。
   * @returns accepted 时完成；不代表 Job complete 或 Run 终态已更新。
   */
  async report(
    jobId: string,
    input: ReportStylePackageProductionV3,
  ): Promise<void> {
    const result = await this.productions.report(jobId, input);
    if (result.status === "accepted") return;
    const definition = reportFailureDefinitions[result.status];
    const body = { code: definition.code, message: definition.message };
    if (definition.kind === "not-found") throw new NotFoundException(body);
    throw new ConflictException(body);
  }
}

const reportFailureDefinitions: Record<
  Exclude<ReportStylePackageProductionResult["status"], "accepted">,
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
    message: "只有 npk-package 类型任务可以回填最终封包证据。",
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
  "package-terminal": {
    kind: "conflict",
    code: "STYLE_PACKAGE_ATTEMPT_TERMINAL",
    message: "当前最终封包 attempt 已封存终态，不能再次回填。",
  },
  "artifact-evidence-mismatch": {
    kind: "conflict",
    code: "STYLE_PACKAGE_ARTIFACT_EVIDENCE_MISMATCH",
    message: "最终封包输出 Artifact 未由当前任务轮次完整生成。",
  },
};
