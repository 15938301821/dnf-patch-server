/**
 * @fileoverview 严格解析 Worker 从已复核官方 BGRA 派生的 V6 target-frame manifest 正文；
 * 不查询数据库、不读取对象存储，也不调用图片模型。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：Repository 先在事务内复核 Artifact 与 finalized upload session 的 Run、Job、lease、
 * attempt 和 provenance；Service 随后通过 ObjectStoragePort 完整读取正文，再调用本模块。输出供
 * 逐帧 target 表和模型执行器使用。副作用仅为内存 UTF-8/JSON 解析和 SHA-256 计算。
 * 安全边界：Artifact 摘要、JCS 唯一编码、官方源摘要、帧身份、Hidden/LINK 策略及聚合预算必须
 * 同时成立。manifest 是 Worker 声明的证据，不会单独授权模型出站、Artifact 写入、部署或兼容声明。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { stableStringifyJcsV1 } from "../../common/utils/canonical.js";
import type { ProfessionSourceFrameManifest } from "./profession-source-frame-manifest.js";

export const professionTargetFrameManifestMaxBytes = 16 * 1024 * 1024;
const maximumTargetFrameCount = 2_048;
const maximumTargetPixelCount = 134_217_728;
const sha256Schema = z.string().regex(/^[A-F0-9]{64}$/u);
const nonNegativeIntegerSchema = z.number().int().min(0).max(1_000_000);
const positiveIntegerSchema = z.number().int().positive().max(1_000_000);
const signedIntegerSchema = z.number().int().min(-1_000_000).max(1_000_000);

const npkInternalPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/^[A-Za-z]:/u.test(value) &&
      value === value.normalize("NFC").toLowerCase() &&
      !value
        .split("/")
        .some(
          (segment) =>
            segment.length === 0 || segment === "." || segment === "..",
        ) &&
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      }),
  );

const targetFrameIdentityFields = {
  frameIndex: nonNegativeIntegerSchema,
  type: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/u),
  compressMode: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/u),
  width: positiveIntegerSchema,
  height: positiveIntegerSchema,
  canvasWidth: positiveIntegerSchema,
  canvasHeight: positiveIntegerSchema,
  x: signedIntegerSchema,
  y: signedIntegerSchema,
};

const generatedTargetFrameSchema = z
  .object({
    ...targetFrameIdentityFields,
    hidden: z.literal(false),
    targetPolicy: z.literal("generate-same-size"),
    linkTargetIndex: z.null(),
    sourceDecodedBgraSha256: sha256Schema,
    sourceAlphaSha256: sha256Schema,
  })
  .strict();

const preservedHiddenFrameSchema = z
  .object({
    ...targetFrameIdentityFields,
    hidden: z.literal(true),
    targetPolicy: z.literal("preserve-hidden-source"),
    linkTargetIndex: z.null(),
    sourceDecodedBgraSha256: sha256Schema,
    sourceAlphaSha256: sha256Schema,
  })
  .strict();

const linkedTargetFrameSchema = z
  .object({
    ...targetFrameIdentityFields,
    hidden: z.boolean(),
    targetPolicy: z.literal("reuse-link-target"),
    linkTargetIndex: nonNegativeIntegerSchema,
    sourceDecodedBgraSha256: z.null(),
    sourceAlphaSha256: z.null(),
  })
  .strict();

/** 三种互斥帧策略；只有可见非 LINK 帧会触发图片模型。 */
export const professionTargetFrameSchema = z.discriminatedUnion(
  "targetPolicy",
  [
    generatedTargetFrameSchema,
    preservedHiddenFrameSchema,
    linkedTargetFrameSchema,
  ],
);

const targetEntrySchema = z
  .object({
    entryIndex: nonNegativeIntegerSchema,
    internalPath: npkInternalPathSchema,
    imgVersion: z.number().int().min(1).max(6),
    frames: z.array(professionTargetFrameSchema).min(1).max(1_000_000),
  })
  .strict()
  .superRefine((entry, context) => {
    for (const [position, frame] of entry.frames.entries()) {
      if (frame.frameIndex !== position) {
        context.addIssue({
          code: "custom",
          path: ["frames", position, "frameIndex"],
          message: "Target frame indexes must be contiguous and ordered.",
        });
      }
      if (
        frame.targetPolicy === "reuse-link-target" &&
        (frame.linkTargetIndex >= entry.frames.length ||
          frame.linkTargetIndex === frame.frameIndex)
      ) {
        context.addIssue({
          code: "custom",
          path: ["frames", position, "linkTargetIndex"],
          message: "LINK target must identify another frame in the same entry.",
        });
      }
    }
    if (hasLinkCycle(entry.frames)) {
      context.addIssue({
        code: "custom",
        path: ["frames"],
        message: "LINK chains must terminate at a non-LINK frame.",
      });
    }
  });

/** 检测同一 IMG 内的 LINK 环；无环保证数据库可按依赖顺序写入，运行时也能有限步解析目标。 */
function hasLinkCycle(
  frames: readonly z.infer<typeof professionTargetFrameSchema>[],
): boolean {
  const states = new Uint8Array(frames.length);
  const visit = (frameIndex: number): boolean => {
    if (states[frameIndex] === 1) return true;
    if (states[frameIndex] === 2) return false;
    states[frameIndex] = 1;
    const frame = frames[frameIndex];
    if (
      frame?.targetPolicy === "reuse-link-target" &&
      visit(frame.linkTargetIndex)
    ) {
      return true;
    }
    states[frameIndex] = 2;
    return false;
  };
  return frames.some((_frame, frameIndex) => visit(frameIndex));
}

/** Worker 与 Server 共同冻结的 V6 官方逐帧目标清单 schema。 */
export const professionTargetFrameManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("profession-target-frame-manifest-v1"),
    sourceSha256: sha256Schema,
    sourceFrameManifestSha256: sha256Schema,
    targetFrameCount: z.number().int().min(1).max(maximumTargetFrameCount),
    targetPixelCount: z.number().int().min(1).max(maximumTargetPixelCount),
    entries: z.array(targetEntrySchema).min(1).max(500),
    safety: z
      .object({
        sourceGeometryAuthoritative: z.literal(true),
        sourceAlphaAuthoritative: z.literal(true),
        targetDimensionsEqualSource: z.literal(true),
        deploymentAuthorized: z.literal(false),
        deploymentPerformed: z.literal(false),
        fullSkillCoverageProven: z.literal(false),
        clientCompatibilityProven: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    let targetFrameCount = 0;
    let targetPixelCount = 0;
    for (const [entryPosition, entry] of manifest.entries.entries()) {
      if (entry.entryIndex !== entryPosition) {
        context.addIssue({
          code: "custom",
          path: ["entries", entryPosition, "entryIndex"],
          message: "Target entries must be contiguous and ordered.",
        });
      }
      for (const frame of entry.frames) {
        if (frame.targetPolicy !== "generate-same-size") continue;
        targetFrameCount += 1;
        targetPixelCount += frame.width * frame.height;
      }
    }
    if (
      targetFrameCount > maximumTargetFrameCount ||
      !Number.isSafeInteger(targetPixelCount) ||
      targetPixelCount > maximumTargetPixelCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetPixelCount"],
        message: "Target frame budget is exceeded.",
      });
    }
    if (manifest.targetFrameCount !== targetFrameCount) {
      context.addIssue({
        code: "custom",
        path: ["targetFrameCount"],
        message: "Target frame count does not match generated frames.",
      });
    }
    if (manifest.targetPixelCount !== targetPixelCount) {
      context.addIssue({
        code: "custom",
        path: ["targetPixelCount"],
        message: "Target pixel count does not match generated frames.",
      });
    }
  });

/** 通过格式、来源、预算和规范编码复核的 V6 target manifest。 */
export type ProfessionTargetFrameManifest = z.infer<
  typeof professionTargetFrameManifestSchema
>;

/** 对象正文解析时必须绑定的数据库/Artifact 身份；值来自已锁定记录，不能来自 manifest 自报。 */
export interface ParseProfessionTargetFrameManifestInput {
  bytes: Uint8Array;
  expectedSha256: string;
  expectedSourceSha256: string;
  expectedSourceFrameManifestSha256: string;
}

/** target manifest 正文、摘要或来源不可信时的稳定内部错误。 */
export class ProfessionTargetFrameManifestError extends Error {
  readonly code = "PROFESSION_TARGET_FRAME_MANIFEST_INVALID";

  constructor() {
    super("PROFESSION_TARGET_FRAME_MANIFEST_INVALID");
    this.name = "ProfessionTargetFrameManifestError";
  }
}

/**
 * 完整验证一个已从私有对象存储读取的 target manifest。
 *
 * @param input 正文字节和 Repository 已复核的 Artifact/官方源摘要。
 * @returns 严格清单；仍不代表对应源 PNG 已上传、模型已出站或任何 target 已生成。
 * @throws ProfessionTargetFrameManifestError 当字节、JCS、schema、来源或预算任一不匹配。
 */
export function parseProfessionTargetFrameManifestBytes(
  input: ParseProfessionTargetFrameManifestInput,
): ProfessionTargetFrameManifest {
  try {
    if (
      input.bytes.byteLength <= 0 ||
      input.bytes.byteLength > professionTargetFrameManifestMaxBytes ||
      !sha256Schema.safeParse(input.expectedSha256).success ||
      !sha256Schema.safeParse(input.expectedSourceSha256).success ||
      !sha256Schema.safeParse(input.expectedSourceFrameManifestSha256)
        .success ||
      sha256(input.bytes) !== input.expectedSha256
    ) {
      throw new Error("TARGET_MANIFEST_IDENTITY_INVALID");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    const parsed: unknown = JSON.parse(text);
    const manifest = professionTargetFrameManifestSchema.parse(parsed);
    if (
      stableStringifyJcsV1(manifest) !== text ||
      manifest.sourceSha256 !== input.expectedSourceSha256 ||
      manifest.sourceFrameManifestSha256 !==
        input.expectedSourceFrameManifestSha256
    ) {
      throw new Error("TARGET_MANIFEST_PROVENANCE_INVALID");
    }
    return manifest;
  } catch (error) {
    if (error instanceof ProfessionTargetFrameManifestError) throw error;
    throw new ProfessionTargetFrameManifestError();
  }
}

/** payload 冻结的 source Entry 身份；顺序决定 target manifest 的 entryIndex。 */
export interface FrozenProfessionSourceEntryIdentity {
  sourceMetadataSha256: string;
}

/**
 * 将 Worker 派生的 target 清单逐帧绑定到 Server 复读的官方 source 清单。
 *
 * @param target 已通过 JCS、Artifact 摘要、来源摘要和预算校验的 target 清单。
 * @param source 已通过历史字节编码、Artifact 摘要、来源和结构校验的完整 Inventory 清单。
 * @param frozenEntries Job payload 中当前技能冻结的 Entry 摘要顺序；不能由 target 自报路径替代。
 * @returns 校验成功时无返回值；不授权模型出站或数据库写入。
 * @throws ProfessionTargetFrameManifestError 当 Entry 映射或任一官方逐帧字段漂移。
 */
export function assertProfessionTargetFrameManifestMatchesSource(
  target: ProfessionTargetFrameManifest,
  source: ProfessionSourceFrameManifest,
  frozenEntries: readonly FrozenProfessionSourceEntryIdentity[],
): void {
  try {
    if (
      target.sourceSha256 !== source.source.sha256 ||
      target.entries.length !== frozenEntries.length
    ) {
      throw new Error("TARGET_SOURCE_SET_INVALID");
    }
    const sourceByMetadataSha256 = new Map(
      source.entries.map((entry) => [entry.metadataSha256, entry]),
    );
    for (const [entryIndex, frozenEntry] of frozenEntries.entries()) {
      if (!sha256Schema.safeParse(frozenEntry.sourceMetadataSha256).success) {
        throw new Error("TARGET_FROZEN_ENTRY_INVALID");
      }
      const sourceEntry = sourceByMetadataSha256.get(
        frozenEntry.sourceMetadataSha256,
      );
      const targetEntry = target.entries[entryIndex];
      if (
        !sourceEntry ||
        !targetEntry ||
        targetEntry.entryIndex !== entryIndex ||
        targetEntry.internalPath !== sourceEntry.internalPath ||
        targetEntry.imgVersion !== sourceEntry.imgVersion ||
        targetEntry.frames.length !== sourceEntry.frames.length
      ) {
        throw new Error("TARGET_SOURCE_ENTRY_INVALID");
      }
      for (const [frameIndex, sourceFrame] of sourceEntry.frames.entries()) {
        const targetFrame = targetEntry.frames[frameIndex];
        if (!targetFrame || !matchesSourceFrame(targetFrame, sourceFrame)) {
          throw new Error("TARGET_SOURCE_FRAME_INVALID");
        }
      }
    }
  } catch (error) {
    if (error instanceof ProfessionTargetFrameManifestError) throw error;
    throw new ProfessionTargetFrameManifestError();
  }
}

/** Alpha SHA 是 Worker 从已复核 BGRA 新派生的值；其余字段必须逐项镜像 source manifest。 */
function matchesSourceFrame(
  target: z.infer<typeof professionTargetFrameSchema>,
  source: ProfessionSourceFrameManifest["entries"][number]["frames"][number],
): boolean {
  const expectedPolicy =
    source.type === "LINK"
      ? "reuse-link-target"
      : source.hidden
        ? "preserve-hidden-source"
        : "generate-same-size";
  return (
    target.frameIndex === source.index &&
    target.type === source.type &&
    target.compressMode === source.compressMode &&
    target.hidden === source.hidden &&
    target.linkTargetIndex === source.linkTargetIndex &&
    target.width === source.width &&
    target.height === source.height &&
    target.canvasWidth === source.canvasWidth &&
    target.canvasHeight === source.canvasHeight &&
    target.x === source.x &&
    target.y === source.y &&
    target.targetPolicy === expectedPolicy &&
    target.sourceDecodedBgraSha256 === source.decodedBgraSha256
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
