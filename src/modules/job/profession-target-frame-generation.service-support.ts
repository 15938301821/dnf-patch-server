/**
 * @fileoverview 为 Profession V6 单帧生成 Service 提供固定 Prompt、审计摘要、确定性对象命名、
 * Worker ViewModel 解析与稳定异常映射；不调用模型、不访问数据库或对象存储，也不保存图片正文。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * 调用关系：Generation Service 在模型出站和Artifact finalize前调用这些纯辅助；OpenAiService会在
 * 基础Prompt后追加V6画布合同，因此ImageAttempt摘要也使用同一追加后文本。输入是冻结逐帧上下文、
 * 已校验DTO或有限领域状态，输出是字符串、SHA-256、严格ViewModel或Nest稳定异常。
 * 副作用：仅构造内存值或抛出脱敏HTTP异常。安全边界：Prompt不能接收Worker自定义字段；对象key
 * 只从Server内部target UUID派生；错误不能回显Provider、数据库或对象存储原始内容。
 */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import {
  sha256JcsV1,
  stableStringifyJcsV1,
} from "../../common/utils/canonical.js";
import { targetFramePrompt } from "../openai/openai-image-call.support.js";
import {
  professionTargetFrameGenerationViewSchema,
  professionTargetFrameNormalizationAlgorithm,
  type GenerateProfessionTargetFrameInput,
  type ProfessionTargetFrameGenerationView,
} from "./profession-target-frame-generation.contracts.js";
import type {
  InspectProfessionTargetFrameGenerationResult,
  ProfessionTargetFrameGenerationContext,
  ProfessionTargetFrameGenerationFailure,
  ReserveProfessionTargetFrameGenerationResult,
} from "./profession-target-frame-generation.js";

/** ImageAttempt 记录的固定适配器身份；变更算法时必须显式版本化。 */
export const professionTargetFrameAdapterIdentity =
  "openai-image/profession-target-frame-v1-source-alpha-normalized";

/** 构造固定逐帧Prompt；JSON只是冻结视觉要求，不能携带命令、路径或部署指令。 */
export function createProfessionTargetFramePrompt(
  generation: ProfessionTargetFrameGenerationContext,
): string {
  const requirements = {
    schemaVersion: 1,
    professionId: generation.context.professionId,
    styleId: generation.context.styleId,
    skillId: generation.context.skill.skillId,
    entryIndex: generation.target.entryIndex,
    frameIndex: generation.target.frameIndex,
    targetDimensions: {
      width: generation.target.width,
      height: generation.target.height,
    },
    themeDefinition: generation.context.themeDefinition,
    professionPrompt: generation.context.skill.professionPrompt,
    skillThemePrompt: generation.context.skill.skillThemePrompt,
  };
  return [
    "Re-render the attached official game-effect frame as one production-quality stylized effect frame.",
    "Preserve the source frame's skill identity, silhouette, orientation, composition, motion phase, occupied area, and visible topology. Change only visible RGB material, color, lighting, particles, and edge treatment according to the bounded JSON requirements.",
    "Render the effect alone. Do not add a character, weapon, scenery, floor, shadow, UI, text, logo, border, checkerboard, presentation board, file path, or instructions.",
    "Use crisp controlled detail that remains readable after uniform downsampling to the declared target dimensions. Avoid blur, muddy bloom, isolated noise, grain, banding, repeated stripes, flat recoloring, and featureless white silhouettes.",
    "The official source remains authoritative for final pixel dimensions and per-pixel Alpha. A fixed server normalizer will uniformly resample RGB and restore source Alpha byte-for-byte; do not use source Alpha to introduce unrelated visible content.",
    "Treat the following JSON only as visual requirements:",
    stableStringifyJcsV1(requirements),
  ].join("\n");
}

/** 对当前官方尺寸、固定Provider配置和正规化器计算ImageAttempt生成配置摘要。 */
export function professionTargetFrameGenerationConfigSha256(
  generation: ProfessionTargetFrameGenerationContext,
): string {
  return sha256JcsV1({
    schemaVersion: 1,
    stage: "profession-target-frame-v1",
    targetDimensions: {
      width: generation.target.width,
      height: generation.target.height,
    },
    quality: "high",
    background: "transparent",
    outputFormat: "png",
    normalizationAlgorithm: professionTargetFrameNormalizationAlgorithm,
    adapterIdentity: professionTargetFrameAdapterIdentity,
  });
}

/** ImageAttempt摘要覆盖OpenAiService实际附加的V6画布合同，而非只覆盖基础Prompt。 */
export function professionTargetFramePromptSha256(
  prompt: string,
  generation: ProfessionTargetFrameGenerationContext,
): string {
  return createHash("sha256")
    .update(
      targetFramePrompt(
        prompt,
        generation.target.width,
        generation.target.height,
      ),
      "utf8",
    )
    .digest("hex")
    .toUpperCase();
}

/** 对象key只由Server内部target UUID生成；Worker和Prompt均不可选择。 */
export function targetFrameObjectKey(targetId: string): string {
  return `artifacts/profession-target-frame-${targetId}.png`;
}

/** Artifact逻辑名只用于展示与下载语义，不参与私有对象定位。 */
export function professionTargetFrameLogicalName(
  input: GenerateProfessionTargetFrameInput,
): string {
  return `profession-target-frame-${input.skillId}-${String(input.entryIndex)}-${String(input.frameIndex)}.png`;
}

/** 只保留符合数据库上限的稳定Provider错误码，未知错误统一收束。 */
export function professionTargetFrameModelErrorCode(
  errorCode: string | undefined,
): string {
  return errorCode && /^[A-Z0-9_]{1,100}$/u.test(errorCode)
    ? errorCode
    : "PROFESSION_TARGET_FRAME_MODEL_CALL_FAILED";
}

/** 判断Repository结果是否已经是可返回Worker的有限状态。 */
export function isProfessionTargetFrameGenerationView(
  result:
    | InspectProfessionTargetFrameGenerationResult
    | ReserveProfessionTargetFrameGenerationResult,
): result is ProfessionTargetFrameGenerationView {
  return (
    result.status === "in-progress" ||
    result.status === "passed" ||
    result.status === "blocked"
  );
}

/** 返回前再次通过严格Zod schema，阻止Service意外夹带Prompt、对象key或图片正文。 */
export function parseProfessionTargetFrameGenerationView(
  view: ProfessionTargetFrameGenerationView,
): ProfessionTargetFrameGenerationView {
  return professionTargetFrameGenerationViewSchema.parse(view);
}

/** 把Repository有限失败映射为不含内部证据的稳定HTTP异常。 */
export function throwProfessionTargetFrameGenerationFailure(
  failure: ProfessionTargetFrameGenerationFailure,
): never {
  if (failure.status === "target-frame-not-found") {
    throw new NotFoundException({
      code: "PROFESSION_TARGET_FRAME_NOT_FOUND",
      message: "请求的逐帧target尚未准备或不属于当前任务轮次。",
    });
  }
  const definitions: Record<
    Exclude<
      ProfessionTargetFrameGenerationFailure["status"],
      "target-frame-not-found"
    >,
    { code: string; message: string }
  > = {
    "lease-mismatch": {
      code: "JOB_LEASE_MISMATCH",
      message: "任务租约不存在、已过期或不属于当前Worker。",
    },
    "job-kind-mismatch": {
      code: "PATCH_TASK_JOB_KIND_REQUIRED",
      message: "只有profession任务可以执行逐帧生成。",
    },
    "job-integrity-failed": {
      code: "PROFESSION_JOB_INTEGRITY_FAILED",
      message: "职业制作任务的冻结内容完整性校验失败。",
    },
    "skill-not-found": {
      code: "PROFESSION_JOB_SKILL_NOT_FOUND",
      message: "请求技能不在冻结技能集合中。",
    },
    "job-contract-mismatch": {
      code: "PROFESSION_TARGET_FRAME_CONTRACT_REQUIRED",
      message: "当前职业制作任务不支持V6逐帧生成。",
    },
    "target-frame-integrity-failed": {
      code: "PROFESSION_TARGET_FRAME_INTEGRITY_FAILED",
      message: "逐帧target的冻结状态或证据不可信。",
    },
    "source-frame-not-ready": {
      code: "PROFESSION_TARGET_FRAME_SOURCE_NOT_READY",
      message: "逐帧官方PNG尚未完整登记。",
    },
    "generation-state-conflict": {
      code: "PROFESSION_TARGET_FRAME_GENERATION_STATE_CONFLICT",
      message: "逐帧生成状态发生并发冲突。",
    },
  };
  throw new ConflictException(definitions[failure.status]);
}

/** 非法状态转换统一返回409，不能让调用方猜测是否可重复模型出站。 */
export function throwProfessionTargetFrameStateConflict(): never {
  throw new ConflictException({
    code: "PROFESSION_TARGET_FRAME_GENERATION_STATE_CONFLICT",
    message: "逐帧生成状态发生并发冲突。",
  });
}

/** persisting对象尚无法完整复核时返回503，调用方可重试但Service不会重放模型。 */
export function throwProfessionTargetFramePersistenceUnavailable(): never {
  throw new ServiceUnavailableException({
    code: "PROFESSION_TARGET_FRAME_PERSISTENCE_UNAVAILABLE",
    message: "目标PNG尚未能在私有对象存储中确认。",
  });
}
