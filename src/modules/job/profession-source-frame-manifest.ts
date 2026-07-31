/**
 * @fileoverview 严格解析 Inventory Worker 历史 source-frame-manifest V1 正文；不查询数据库、
 * 不访问对象存储、不读取官方 NPK，也不执行本机工具。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * 调用关系：V6 target prepare Service 在 Repository 复核 source Artifact 归属后读取私有对象正文，
 * 再调用本模块；输出交给 target/source 逐帧交叉核验。输入是对象字节和数据库冻结的摘要、源长度、
 * 源 SHA、工具 SHA，输出是不含像素正文或本机路径的严格结构。
 * 副作用仅为进程内 UTF-8/JSON 解析和 SHA-256 计算。
 * 安全边界：历史清单使用 Worker 固定 `JSON.stringify` 编码而非 JCS；正文摘要、唯一字节编码、
 * 来源身份、Entry 元数据摘要、帧索引、Hidden/LINK 计数及 LINK 无环必须同时成立。解析成功不授权
 * 模型出站、Artifact 写入、部署或客户端兼容结论。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const professionSourceFrameManifestMaxBytes = 64 * 1024 * 1024;
const maximumSourceEntryCount = 100_000;
const maximumSourceFrameCount = 100_000_000;
const sha256Schema = z.string().regex(/^[A-F0-9]{64}$/u);
const frameIntegerSchema = z.number().int().min(0).max(1_000_000);
const signedIntegerSchema = z.number().int().min(-1_000_000).max(1_000_000);
const frameTokenSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

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

/** Inventory 固定 Scanner 观察到的单帧事实；LINK 与像素摘要互斥。 */
export const professionSourceFrameSchema = z
  .object({
    index: frameIntegerSchema,
    type: frameTokenSchema,
    compressMode: frameTokenSchema,
    hidden: z.boolean(),
    linkTargetIndex: frameIntegerSchema.nullable(),
    width: frameIntegerSchema,
    height: frameIntegerSchema,
    canvasWidth: frameIntegerSchema,
    canvasHeight: frameIntegerSchema,
    x: signedIntegerSchema,
    y: signedIntegerSchema,
    decodedBgraSha256: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((frame, context) => {
    const isLink = frame.type === "LINK";
    if (isLink !== (frame.linkTargetIndex !== null)) {
      context.addIssue({
        code: "custom",
        path: ["linkTargetIndex"],
        message: "Only LINK frames can identify a LINK target.",
      });
    }
    if (isLink === (frame.decodedBgraSha256 !== null)) {
      context.addIssue({
        code: "custom",
        path: ["decodedBgraSha256"],
        message: "Only non-LINK frames can carry decoded BGRA evidence.",
      });
    }
  });

/** 一个 source-frame manifest Entry；metadataSha256 采用 Inventory V1 的历史字段顺序计算。 */
export const professionSourceFrameEntrySchema = z
  .object({
    internalPath: npkInternalPathSchema,
    imgVersion: z.number().int().min(1).max(6),
    frameCount: frameIntegerSchema,
    linkCount: frameIntegerSchema,
    hiddenCount: frameIntegerSchema,
    metadataSha256: sha256Schema,
    frames: z.array(professionSourceFrameSchema).max(1_000_000),
  })
  .strict()
  .superRefine((entry, context) => {
    const linkCount = entry.frames.filter(
      (frame) => frame.type === "LINK",
    ).length;
    const hiddenCount = entry.frames.filter((frame) => frame.hidden).length;
    for (const [position, frame] of entry.frames.entries()) {
      if (frame.index !== position) {
        context.addIssue({
          code: "custom",
          path: ["frames", position, "index"],
          message: "Source frame indexes must be contiguous and ordered.",
        });
      }
      if (
        frame.linkTargetIndex !== null &&
        (frame.linkTargetIndex >= entry.frames.length ||
          frame.linkTargetIndex === frame.index)
      ) {
        context.addIssue({
          code: "custom",
          path: ["frames", position, "linkTargetIndex"],
          message: "LINK target must identify another frame in the same entry.",
        });
      }
    }
    if (
      entry.frameCount !== entry.frames.length ||
      entry.linkCount !== linkCount ||
      entry.hiddenCount !== hiddenCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["frameCount"],
        message: "Source entry aggregate counts do not match its frames.",
      });
    }
    if (entry.metadataSha256 !== sourceEntryMetadataSha256(entry)) {
      context.addIssue({
        code: "custom",
        path: ["metadataSha256"],
        message: "Source entry metadata digest does not match its identity.",
      });
    }
    if (hasSourceLinkCycle(entry.frames)) {
      context.addIssue({
        code: "custom",
        path: ["frames"],
        message: "Source LINK chains must terminate at a non-LINK frame.",
      });
    }
  });

/** Inventory Worker 上传的历史 V1 source-frame manifest 完整 schema。 */
export const professionSourceFrameManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("source-frame-manifest"),
    source: z
      .object({
        label: z.string().min(1).max(200),
        byteLength: z.number().int().positive().max(4_294_967_295),
        sha256: sha256Schema,
      })
      .strict(),
    tool: z.object({ sha256: sha256Schema }).strict(),
    safety: z
      .object({
        deploymentAuthorized: z.literal(false),
        deploymentPerformed: z.literal(false),
        fullSkillCoverageProven: z.literal(false),
        clientCompatibilityProven: z.literal(false),
      })
      .strict(),
    entries: z
      .array(professionSourceFrameEntrySchema)
      .min(1)
      .max(maximumSourceEntryCount),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.entries.map((entry) => entry.internalPath);
    const metadataDigests = manifest.entries.map(
      (entry) => entry.metadataSha256,
    );
    const frameCount = manifest.entries.reduce(
      (total, entry) => total + entry.frames.length,
      0,
    );
    if (
      new Set(paths).size !== paths.length ||
      new Set(metadataDigests).size !== metadataDigests.length ||
      !Number.isSafeInteger(frameCount) ||
      frameCount > maximumSourceFrameCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Source entries must be unique and stay within frame budgets.",
      });
    }
  });

/** 通过正文、来源和逐帧守恒复核的历史 source-frame manifest。 */
export type ProfessionSourceFrameManifest = z.infer<
  typeof professionSourceFrameManifestSchema
>;

/** source Artifact 正文解析所需的数据库冻结身份，不能来自正文自报。 */
export interface ParseProfessionSourceFrameManifestInput {
  bytes: Uint8Array;
  expectedSha256: string;
  expectedSourceSha256: string;
  expectedSourceByteLength: number;
  expectedToolSha256: string;
}

/** source manifest 正文或身份不可信时的脱敏稳定内部错误。 */
export class ProfessionSourceFrameManifestError extends Error {
  readonly code = "PROFESSION_SOURCE_FRAME_MANIFEST_INVALID";

  constructor() {
    super("PROFESSION_SOURCE_FRAME_MANIFEST_INVALID");
    this.name = "ProfessionSourceFrameManifestError";
  }
}

/**
 * 验证私有对象存储中的历史 source-frame manifest 正文。
 * @param input 正文字节与 Repository 从 Artifact、Inventory 和 provenance 取得的预期身份。
 * @returns 完整严格清单；仍不证明 Worker 当前 lease、target manifest 或模型状态。
 * @throws ProfessionSourceFrameManifestError 当摘要、编码、schema 或来源任一不匹配。
 */
export function parseProfessionSourceFrameManifestBytes(
  input: ParseProfessionSourceFrameManifestInput,
): ProfessionSourceFrameManifest {
  try {
    if (
      input.bytes.byteLength <= 0 ||
      input.bytes.byteLength > professionSourceFrameManifestMaxBytes ||
      !sha256Schema.safeParse(input.expectedSha256).success ||
      !sha256Schema.safeParse(input.expectedSourceSha256).success ||
      !sha256Schema.safeParse(input.expectedToolSha256).success ||
      !Number.isInteger(input.expectedSourceByteLength) ||
      input.expectedSourceByteLength <= 0 ||
      sha256(input.bytes) !== input.expectedSha256
    ) {
      throw new Error("SOURCE_MANIFEST_IDENTITY_INVALID");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    const parsed: unknown = JSON.parse(text);
    const manifest = professionSourceFrameManifestSchema.parse(parsed);
    if (
      JSON.stringify(manifest) !== text ||
      manifest.source.sha256 !== input.expectedSourceSha256 ||
      manifest.source.byteLength !== input.expectedSourceByteLength ||
      manifest.tool.sha256 !== input.expectedToolSha256
    ) {
      throw new Error("SOURCE_MANIFEST_PROVENANCE_INVALID");
    }
    return manifest;
  } catch (error) {
    if (error instanceof ProfessionSourceFrameManifestError) throw error;
    throw new ProfessionSourceFrameManifestError();
  }
}

/** 重现 Inventory V1 metadata 对象的字段顺序；不能改用 JCS，否则会破坏既有 Artifact 身份。 */
function sourceEntryMetadataSha256(
  entry: z.infer<typeof professionSourceFrameEntrySchema>,
): string {
  return sha256(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        internalPath: entry.internalPath,
        imgVersion: entry.imgVersion,
        frameCount: entry.frameCount,
        linkCount: entry.linkCount,
        hiddenCount: entry.hiddenCount,
      }),
      "utf8",
    ),
  );
}

/** 三色状态 DFS：1 表示当前路径，2 表示已证明无环。 */
function hasSourceLinkCycle(
  frames: readonly z.infer<typeof professionSourceFrameSchema>[],
): boolean {
  const states = new Uint8Array(frames.length);
  const visit = (frameIndex: number): boolean => {
    if (states[frameIndex] === 1) return true;
    if (states[frameIndex] === 2) return false;
    states[frameIndex] = 1;
    const target = frames[frameIndex]?.linkTargetIndex;
    if (target !== null && target !== undefined && visit(target)) return true;
    states[frameIndex] = 2;
    return false;
  };
  return frames.some((_frame, frameIndex) => visit(frameIndex));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}
