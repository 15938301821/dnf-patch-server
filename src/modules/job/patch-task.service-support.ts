/**
 * @fileoverview 承载 PatchTaskService 的纯结果映射与冻结 Run/Package 输入构造；不注入 provider、
 * 不访问数据库、对象存储或外部工具，也不改变 Run、Job 或 Artifact 终态。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-26
 * @relatedPlan N/A - Package V3 浏览器产物验收后的服务文件规模收口
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import type { FactoryConfig } from "../factory/factory.contracts.js";
import type { StyleBuildContext } from "../profession/profession.contracts.js";
import type { CreateRunInput } from "../run/run.contracts.js";
import type { PatchTaskReportResult } from "./patch-task.contracts.js";
import type {
  FrozenProfessionSkillExecutionContext,
  ResolveProfessionExecutionContextResult,
} from "./profession-execution-context.js";
import type { ProfessionProductionProgressView } from "./profession-production-progress.contracts.js";
import type { StyleSkillProductionJobPayloadV2 } from "./style-skill-production.contracts.js";
import {
  createStylePackageProductionJobPayloadV3,
  type StylePackageProductionJobPayloadV3,
} from "./style-package-production.contracts.js";

export type PackageConfigKey =
  | "STYLE_PACKAGE_PROFILE_ID"
  | "STYLE_PACKAGE_PACKAGER_TOOL_ID"
  | "STYLE_PACKAGE_PACKAGER_SHA256"
  | "STYLE_PACKAGE_VALIDATOR_TOOL_ID"
  | "STYLE_PACKAGE_VALIDATOR_SHA256"
  | "STYLE_PACKAGE_DIRECTXTEX_TOOL_ID"
  | "STYLE_PACKAGE_TEXCONV_SHA256"
  | "STYLE_PACKAGE_TEXDIAG_SHA256"
  | "STYLE_PACKAGE_EXTRACTORSHARP_TOOL_ID"
  | "STYLE_PACKAGE_EXTRACTOR_CORE_SHA256"
  | "STYLE_PACKAGE_EXTRACTOR_JSON_SHA256"
  | "STYLE_PACKAGE_EXTRACTOR_ZLIB_SHA256";

export interface PackageProfileConfigPort {
  get(key: PackageConfigKey, options?: { infer: true }): string | undefined;
}

type RunnableFactoryConfig = Extract<FactoryConfig, { schemaVersion: 2 | 3 }>;

/** 把 Worker 回填的有限 Repository 结果映射为稳定 HTTP 异常。 */
export function assertPatchTaskReportAccepted(
  result: PatchTaskReportResult,
): void {
  if (result.status === "accepted") return;
  const definition = reportFailureDefinitions[result.status];
  const body = { code: definition.code, message: definition.message };
  if (definition.kind === "not-found") throw new NotFoundException(body);
  throw new ConflictException(body);
}

/** 把租约约束的 Profession 上下文结果收窄为服务内冻结上下文。 */
export function requireProfessionExecutionContext(
  result: ResolveProfessionExecutionContextResult,
): FrozenProfessionSkillExecutionContext {
  if (result.status === "accepted") return result.context;
  const definition = professionExecutionFailureDefinitions[result.status];
  const body = { code: definition.code, message: definition.message };
  if (definition.kind === "not-found") throw new NotFoundException(body);
  throw new ConflictException(body);
}

/** 把当前 lease 的多技能进度结果映射为有限 ViewModel 或稳定冲突。 */
export function requireProfessionProgress(
  result:
    | { status: "accepted"; progress: ProfessionProductionProgressView }
    | {
        status:
          | "lease-mismatch"
          | "job-kind-mismatch"
          | "job-integrity-failed"
          | "production-integrity-failed";
      },
): ProfessionProductionProgressView {
  if (result.status === "accepted") return result.progress;
  const definition = professionProgressFailureDefinitions[result.status];
  throw new ConflictException({
    code: definition.code,
    message: definition.message,
  });
}

/** 构造只含声明式 Job 与四项 false 安全声明的冻结 Run 输入。 */
export function createPatchTaskRunInput(
  context: StyleBuildContext,
  factoryConfig: RunnableFactoryConfig,
  idempotencyKey: string,
  payload: StyleSkillProductionJobPayloadV2,
  packagePayload: StylePackageProductionJobPayloadV3,
): CreateRunInput {
  if (
    !context.profession.workflowProjectId ||
    !context.profession.catalogSnapshotId
  ) {
    throw new Error("PROFESSION_WORKFLOW_CONTEXT_MISSING");
  }
  const requestBody = {
    action: "generate-patch",
    professionId: context.profession.id,
    styleId: context.style.id,
    selectedSkillIds: context.style.selectedSkillIds,
    payload,
  };
  return {
    projectId: context.profession.workflowProjectId,
    snapshotId: context.profession.catalogSnapshotId,
    clientRunId: `patch.${sha256JcsV1({
      idempotencyKey,
      professionId: context.profession.id,
      styleId: context.style.id,
    })}`,
    action: "generate-patch",
    requestSha256: sha256JcsV1(requestBody),
    serverConnectionEnabled: true,
    modelEgressAuthorized: true,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    jobs: [
      { kind: "profession", payload, maxAttempts: 3 },
      { kind: "npk-package", payload: packagePayload, maxAttempts: 3 },
    ],
    policyId: factoryConfig.policyId,
    policySha256: factoryConfig.policySha256,
  };
}

/** 从进程固定配置构造与 Factory contract 完全一致的 Package V3 payload。 */
export function createPatchTaskPackagePayload(
  config: PackageProfileConfigPort,
  context: StyleBuildContext,
  contractProfileId: string,
): StylePackageProductionJobPayloadV3 {
  const profileId = config.get("STYLE_PACKAGE_PROFILE_ID", { infer: true });
  const packagerToolId = config.get("STYLE_PACKAGE_PACKAGER_TOOL_ID", {
    infer: true,
  });
  const packagerSha256 = config.get("STYLE_PACKAGE_PACKAGER_SHA256", {
    infer: true,
  });
  const validatorToolId = config.get("STYLE_PACKAGE_VALIDATOR_TOOL_ID", {
    infer: true,
  });
  const validatorSha256 = config.get("STYLE_PACKAGE_VALIDATOR_SHA256", {
    infer: true,
  });
  const directXTexToolId = config.get("STYLE_PACKAGE_DIRECTXTEX_TOOL_ID", {
    infer: true,
  });
  const texconvSha256 = config.get("STYLE_PACKAGE_TEXCONV_SHA256", {
    infer: true,
  });
  const texdiagSha256 = config.get("STYLE_PACKAGE_TEXDIAG_SHA256", {
    infer: true,
  });
  const extractorSharpToolId = config.get(
    "STYLE_PACKAGE_EXTRACTORSHARP_TOOL_ID",
    { infer: true },
  );
  const extractorCoreSha256 = config.get(
    "STYLE_PACKAGE_EXTRACTOR_CORE_SHA256",
    { infer: true },
  );
  const extractorJsonSha256 = config.get(
    "STYLE_PACKAGE_EXTRACTOR_JSON_SHA256",
    { infer: true },
  );
  const extractorZlibSha256 = config.get(
    "STYLE_PACKAGE_EXTRACTOR_ZLIB_SHA256",
    { infer: true },
  );
  if (
    !profileId ||
    !packagerToolId ||
    !packagerSha256 ||
    !validatorToolId ||
    !validatorSha256 ||
    !directXTexToolId ||
    !texconvSha256 ||
    !texdiagSha256 ||
    !extractorSharpToolId ||
    !extractorCoreSha256 ||
    !extractorJsonSha256 ||
    !extractorZlibSha256 ||
    profileId !== contractProfileId
  ) {
    throw new Error("STYLE_PACKAGE_PROFILE_NOT_FROZEN");
  }
  return createStylePackageProductionJobPayloadV3({
    profileId,
    professionId: context.profession.id,
    styleId: context.style.id,
    selectedSkillIds: context.style.selectedSkillIds,
    packager: { toolId: packagerToolId, sha256: packagerSha256 },
    validator: { toolId: validatorToolId, sha256: validatorSha256 },
    directXTex: { toolId: directXTexToolId, texconvSha256, texdiagSha256 },
    extractorSharp: {
      toolId: extractorSharpToolId,
      coreSha256: extractorCoreSha256,
      jsonSha256: extractorJsonSha256,
      zlibSha256: extractorZlibSha256,
    },
  });
}

const professionProgressFailureDefinitions = {
  "lease-mismatch": {
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    code: "PATCH_TASK_JOB_KIND_REQUIRED",
    message: "只有 profession 类型任务可以读取职业生产进度。",
  },
  "job-integrity-failed": {
    code: "PROFESSION_JOB_INTEGRITY_FAILED",
    message: "职业制作任务的冻结内容完整性校验失败。",
  },
  "production-integrity-failed": {
    code: "PROFESSION_PRODUCTION_EVIDENCE_MISMATCH",
    message: "职业技能生产证据与冻结任务不一致。",
  },
} as const;

const professionExecutionFailureDefinitions: Record<
  Exclude<ResolveProfessionExecutionContextResult["status"], "accepted">,
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
    message: "只有 profession 类型任务可以请求固定技能生产步骤。",
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
};

const reportFailureDefinitions: Record<
  Exclude<PatchTaskReportResult["status"], "accepted">,
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
    message: "只有 profession 类型任务可以回填主题技能生产证据。",
  },
  "skill-production-not-found": {
    kind: "not-found",
    code: "STYLE_SKILL_PRODUCTION_NOT_FOUND",
    message: "主题技能生产记录不存在。",
  },
  "skill-production-terminal": {
    kind: "conflict",
    code: "STYLE_SKILL_PRODUCTION_TERMINAL",
    message: "主题技能生产记录已终结，不能再次回填。",
  },
  "skill-production-evidence-mismatch": {
    kind: "conflict",
    code: "STYLE_SKILL_PRODUCTION_EVIDENCE_MISMATCH",
    message: "主题技能生产记录与当前冻结任务证据不一致。",
  },
  "model-execution-evidence-mismatch": {
    kind: "conflict",
    code: "STYLE_SKILL_MODEL_EXECUTION_EVIDENCE_MISMATCH",
    message: "当前任务轮次的固定模型执行证据不完整或不一致。",
  },
  "artifact-evidence-mismatch": {
    kind: "conflict",
    code: "STYLE_SKILL_ARTIFACT_EVIDENCE_MISMATCH",
    message: "技能输出 Artifact 未由当前任务轮次完整生成。",
  },
  "package-not-found": {
    kind: "not-found",
    code: "STYLE_PACKAGE_NOT_FOUND",
    message: "主题包记录不存在。",
  },
  "package-terminal": {
    kind: "conflict",
    code: "STYLE_PACKAGE_TERMINAL",
    message: "主题包记录已终结，不能再次回填。",
  },
  "package-capability-not-frozen": {
    kind: "conflict",
    code: "STYLE_PACKAGE_CAPABILITY_NOT_FROZEN",
    message: "当前职业制作任务未冻结最终封包工具与验证契约。",
  },
};
