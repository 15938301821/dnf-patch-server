/**
 * @fileoverview 严格读取 Profession validation ZIP 的首个固定 manifest，并生成脱敏领域摘要；
 * 不访问数据库或对象存储、不解压帧文件、不执行 Worker 工具，也不信任 ZIP 元数据或 JSON。
 * @module scripts/profession-persistence-manifest
 * @author AI生成
 * @created 2026-07-26
 * @relatedPlan N/A - 用户直接要求继续整理本地诊断脚本
 *
 * 调用关系：profession-persistence-probe-support.cjs 在完成对象长度与 SHA-256 核验后调用；
 * 下游只使用 Server 自身固定版本的 yauzl 与 Zod。输入是最多 512 MiB 的已核验 validation ZIP，
 * 输出为来源哈希、IMG 路径、版本、帧数和帧类型摘要。
 * 副作用：无持久化副作用，只在内存中读取首个 manifest entry。
 * 安全边界：manifest 必须是首个、未加密、有界 entry；未知字段、非 Ver5、索引或计数不守恒、
 * 四项安全声明及参考图运行像素声明不为 false 时必须失败关闭。
 */
const yauzl = require("yauzl");
const { z } = require("zod");

const maxObjectBytes = 512 * 1024 * 1024;
const maxManifestBytes = 64 * 1024 * 1024;
const maxFrameCount = 100_000;
const maxZipEntries = 100_001;
const sha256Schema = z.string().regex(/^[A-F0-9]{64}$/u);
const boundedInteger = z.number().int().min(0).max(1_000_000);
const signedInteger = z.number().int().min(-1_000_000).max(1_000_000);
const frameTokenSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

const frameCommon = {
  index: boundedInteger,
  type: frameTokenSchema,
  compressMode: frameTokenSchema,
  hidden: z.boolean(),
  linkTargetIndex: boundedInteger.nullable(),
  width: boundedInteger,
  height: boundedInteger,
  canvasWidth: boundedInteger,
  canvasHeight: boundedInteger,
  x: signedInteger,
  y: signedInteger,
  decodedBgraSha256: sha256Schema.nullable(),
};
const linkFrameSchema = z
  .object({
    ...frameCommon,
    type: z.literal("LINK"),
    linkTargetIndex: boundedInteger,
    decodedBgraSha256: z.null(),
    output: z.literal(false),
  })
  .strict();
const outputFrameSchema = z
  .object({
    ...frameCommon,
    type: frameTokenSchema.refine((value) => value !== "LINK"),
    linkTargetIndex: z.null(),
    decodedBgraSha256: sha256Schema,
    output: z.literal(true),
    file: z.string().min(1).max(160),
    byteLength: z.number().int().min(1).max(maxObjectBytes),
    sha256: sha256Schema,
  })
  .strict();
const manifestEntrySchema = z
  .object({
    entryIndex: z.number().int().min(0).max(499),
    internalPath: z.string().min(1).max(500),
    imgVersion: z.literal(5),
    frameCount: boundedInteger,
    frames: z
      .array(z.union([linkFrameSchema, outputFrameSchema]))
      .max(maxFrameCount),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum([
      "dnf-profession-aseprite-projects-bundle-v1",
      "dnf-profession-aseprite-validation-bundle-v1",
    ]),
    sourceSha256: sha256Schema,
    outputFrameCount: z.number().int().min(1).max(maxFrameCount),
    linkFrameCount: z.number().int().min(0).max(maxFrameCount),
    entries: z.array(manifestEntrySchema).min(1).max(500),
    safety: z
      .object({
        referenceImageUsedForRuntimePixels: z.literal(false),
        deploymentAuthorized: z.literal(false),
        deploymentPerformed: z.literal(false),
        fullSkillCoverageProven: z.literal(false),
        clientCompatibilityProven: z.literal(false),
      })
      .strict(),
  })
  .strict();

/** ZIP 或 manifest 不满足固定契约时使用的稳定、脱敏错误。 */
class ManifestProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ManifestProbeError";
    this.code = code;
  }
}

/**
 * 从内存 ZIP 读取首个固定 manifest，并执行 schema、索引及计数守恒校验。
 * @param {Buffer} bytes 已通过数据库长度和 SHA-256 核验的 validation Artifact 字节。
 * @returns {Promise<object>} 不包含帧文件正文的有界 manifest 摘要。
 * @throws {ManifestProbeError} ZIP 预算、entry 顺序、JSON schema 或计数不变量失败。
 */
function readZipManifest(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (openError, zip) => {
        if (openError || !zip) {
          reject(new ManifestProbeError("ZIP_OPEN_FAILED"));
          return;
        }
        let settled = false;
        let entryCount = 0;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(
            error instanceof ManifestProbeError
              ? error
              : new ManifestProbeError(error),
          );
        };
        zip.on("error", () => fail("ZIP_READ_FAILED"));
        zip.on("end", () => fail("ZIP_MANIFEST_NOT_FOUND"));
        zip.on("entry", (entry) => {
          entryCount += 1;
          if (entryCount > maxZipEntries) {
            fail("ZIP_ENTRY_BUDGET_EXCEEDED");
            return;
          }
          if (entry.fileName !== "profession-output-manifest.json") {
            zip.readEntry();
            return;
          }
          if (
            entryCount !== 1 ||
            entry.uncompressedSize <= 0 ||
            entry.uncompressedSize > maxManifestBytes ||
            (entry.generalPurposeBitFlag & 0x1) !== 0
          ) {
            fail("ZIP_MANIFEST_INVALID");
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail("ZIP_MANIFEST_READ_FAILED");
              return;
            }
            const chunks = [];
            let byteLength = 0;
            stream.on("data", (chunk) => {
              const chunkBytes = Buffer.from(chunk);
              byteLength += chunkBytes.byteLength;
              if (byteLength > maxManifestBytes) {
                stream.destroy();
                fail("ZIP_MANIFEST_BUDGET_EXCEEDED");
                return;
              }
              chunks.push(chunkBytes);
            });
            stream.on("error", () => fail("ZIP_MANIFEST_READ_FAILED"));
            stream.on("end", () => {
              if (settled) return;
              try {
                const manifest = manifestSchema.parse(
                  JSON.parse(
                    Buffer.concat(chunks, byteLength).toString("utf8"),
                  ),
                );
                if (
                  manifest.kind !==
                  "dnf-profession-aseprite-validation-bundle-v1"
                ) {
                  throw new ManifestProbeError(
                    "PACKAGE_MANIFEST_ROLE_MISMATCH",
                  );
                }
                const summary = summarizeManifest(manifest);
                settled = true;
                zip.close();
                resolve(summary);
              } catch (error) {
                fail(
                  error instanceof ManifestProbeError
                    ? error
                    : new ManifestProbeError("PACKAGE_MANIFEST_INVALID"),
                );
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

function summarizeManifest(manifest) {
  let outputFrameCount = 0;
  let linkFrameCount = 0;
  const entries = manifest.entries.map((entry, entryIndex) => {
    if (
      entry.entryIndex !== entryIndex ||
      entry.frameCount !== entry.frames.length
    ) {
      throw new ManifestProbeError("PACKAGE_MANIFEST_COUNT_MISMATCH");
    }
    for (const [frameIndex, frame] of entry.frames.entries()) {
      if (frame.index !== frameIndex) {
        throw new ManifestProbeError("PACKAGE_MANIFEST_INDEX_MISMATCH");
      }
      if (frame.type === "LINK") linkFrameCount += 1;
      else outputFrameCount += 1;
    }
    return {
      internalPath: entry.internalPath,
      imgVersion: entry.imgVersion,
      frameCount: entry.frameCount,
      frameTypes: [...new Set(entry.frames.map((frame) => frame.type))],
    };
  });
  if (
    outputFrameCount !== manifest.outputFrameCount ||
    linkFrameCount !== manifest.linkFrameCount
  ) {
    throw new ManifestProbeError("PACKAGE_MANIFEST_COUNT_MISMATCH");
  }
  return {
    kind: manifest.kind,
    sourceSha256: manifest.sourceSha256,
    outputFrameCount,
    linkFrameCount,
    entries,
  };
}

module.exports = { ManifestProbeError, readZipManifest };
