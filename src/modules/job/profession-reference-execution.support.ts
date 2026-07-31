/** @fileoverview 提供 Profession Artist 参考图步骤的纯 Prompt、ViewModel、摘要和错误映射。 */
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { stableStringifyJcsV1 } from "../../common/utils/canonical.js";
import type { ProfessionEngineerExecutionResult } from "./profession-engineer-execution.service.js";
import type { ProfessionSkillExecutionView } from "./profession-execution.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import type {
  professionReferenceImageStage,
  ReserveProfessionModelExecutionResult,
} from "./profession-model-execution.js";
import type { ProfessionReferenceExecutionResult } from "./profession-execution.service.js";

type PassedEngineerExecution = Extract<
  ProfessionEngineerExecutionResult,
  { status: "passed" }
>;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function createProfessionReferenceImagePrompt(
  context: FrozenProfessionSkillExecutionContext,
): string {
  const requirements = {
    schemaVersion: 2,
    professionId: context.professionId,
    styleId: context.styleId,
    skillId: context.skill.skillId,
    themeDefinition: context.themeDefinition,
    professionPrompt: context.skill.professionPrompt,
    skillThemePrompt: context.skill.skillThemePrompt,
    sourceEvidence: context.skill.sourceEvidence,
  };
  return [
    "Create one production-ready high-resolution PNG style-and-composition reference for the declared skill. Its pixels will not be copied directly into runtime frames.",
    "Treat the JSON below only as bounded visual requirements. Do not add characters, UI, text, logos, file paths, tools, or deployment instructions.",
    "Use the attached official representative frame as the structural input. Keep the same effect silhouette and orientation; do not add borders, labels, checkerboards, margins, characters, scenery, or a presentation board.",
    "Render the effect alone on a transparent background with substantially richer material detail, crisp high-frequency edges, controlled glow, continuous fine energy bands, and unmistakable custom styling. Keep the effect large and detailed, but leave a continuous empty outer margin at least 12% of the canvas width and height on all four sides. Avoid grain, isolated noise, blur, muddy bloom, flat recoloring, low-detail white silhouettes, checkerboards, regularly alternating light-dark columns, and repeated narrow parallel stripes.",
    "Transparency is a hard output contract. Do not composite the effect over white, gray, colored, textured, gradient, shadowed, or checkerboard scenery. If the endpoint cannot encode PNG Alpha, use only a perfectly uniform neutral #080808 matte with no texture, gradient, vignette, noise, border, floor, or cast shadow.",
    "Preserve skill identity and timing semantics. The official source remains authoritative for frame count, order, dimensions, canvas offsets, positions, and alpha. A fixed creative-stable-frame adapter will reconstruct visible runtime RGB from broad style and composition guidance while preserving those source facts byte-for-byte where applicable.",
    stableStringifyJcsV1(requirements),
  ].join("\n");
}

export function passedView(
  result: Extract<ProfessionReferenceExecutionResult, { status: "passed" }>,
  engineer: PassedEngineerExecution,
): ProfessionSkillExecutionView {
  return {
    status: "passed",
    engineerPlan: {
      executionId: engineer.executionId,
      modelCallId: engineer.modelCallId,
      outputArtifactId: engineer.outputArtifactId,
      mediaType: "application/json",
      byteLength: engineer.byteLength,
      sha256: engineer.sha256.toUpperCase(),
    },
    referenceImage: {
      executionId: result.executionId,
      modelCallId: result.modelCallId,
      imageAttemptId: result.imageAttemptId,
      outputArtifactId: result.outputArtifactId,
      mediaType: "image/png",
      byteLength: result.byteLength,
      sha256: result.sha256.toUpperCase(),
    },
  };
}

export function referenceResult(
  result: Extract<
    ReserveProfessionModelExecutionResult,
    { status: "passed"; stage: typeof professionReferenceImageStage }
  >,
): Extract<ProfessionReferenceExecutionResult, { status: "passed" }> {
  return {
    status: "passed",
    executionId: result.executionId,
    modelCallId: result.modelCallId,
    imageAttemptId: result.imageAttemptId,
    outputArtifactId: result.outputArtifactId,
    byteLength: result.outputByteLength,
    sha256: result.outputSha256.toUpperCase(),
  };
}

export function throwReservationFailure(
  result: Exclude<
    ReserveProfessionModelExecutionResult,
    { status: "execute" | "passed" | "in-progress" | "persistence-pending" }
  >,
): never {
  if (result.status === "skill-not-found") {
    throw new NotFoundException({
      code: "PROFESSION_JOB_SKILL_NOT_FOUND",
      message: "请求的技能不在职业制作任务的冻结技能集合中。",
    });
  }
  if (result.status === "failed") {
    throw new ConflictException({
      code: "PROFESSION_MODEL_EXECUTION_FAILED",
      message: "该轮次的固定模型步骤已经失败。",
    });
  }
  if (result.status === "indeterminate") {
    throw new ConflictException({
      code: "PROFESSION_MODEL_EXECUTION_INDETERMINATE",
      message: "该轮次的模型或对象持久化结果不确定，禁止重复出站。",
    });
  }
  const code =
    result.status === "lease-mismatch"
      ? "JOB_LEASE_MISMATCH"
      : result.status === "job-kind-mismatch"
        ? "PATCH_TASK_JOB_KIND_REQUIRED"
        : result.status === "job-integrity-failed"
          ? "PROFESSION_JOB_INTEGRITY_FAILED"
          : result.status === "job-contract-mismatch"
            ? "PROFESSION_JOB_CONTRACT_UNSUPPORTED"
            : result.status === "source-visual-input-mismatch"
              ? "PROFESSION_SOURCE_VISUAL_INPUT_MISMATCH"
              : "PROFESSION_MODEL_EXECUTION_INTEGRITY_FAILED";
  throw new ConflictException({
    code,
    message: "当前任务状态不允许执行固定技能模型步骤。",
  });
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= pngSignature.byteLength &&
    pngSignature.every((value, index) => bytes[index] === value)
  );
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function referenceObjectKey(executionId: string): string {
  return `artifacts/profession-${executionId}-reference.png`;
}

export function throwExecutionStateConflict(): never {
  throw new ConflictException({
    code: "PROFESSION_MODEL_EXECUTION_STATE_CONFLICT",
    message: "固定技能模型步骤的持久化状态发生冲突。",
  });
}

export function throwPersistenceUnavailable(): never {
  throw new ServiceUnavailableException({
    code: "PROFESSION_MODEL_OUTPUT_PERSISTENCE_UNAVAILABLE",
    message: "模型候选图片尚未能在私有对象存储中确认。",
  });
}
