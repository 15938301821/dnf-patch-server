/**
 * @fileoverview 解码并规范化 Profession Artist 返回的高分辨率 PNG；不访问数据库、对象存储或模型。
 * @module modules/job/profession-reference-image
 * @author AI生成
 * @created 2026-07-26
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：ProfessionExecutionService 在预留对象容量前调用本文件；输入是不可信模型图片字节，
 * 输出是同时具有可见像素和透明背景、且透明 RGB 已清零的 PNG。全不透明图片仅在深色中性画布可由
 * 固定亮度/色度规则确定性分离时转换，否则失败关闭，不能把展示画布伪装成 runtime 参考图。
 */
import sharp from "sharp";
import { deriveNeutralPaletteAlpha } from "./profession-reference-neutral-alpha.js";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maximumImageBytes = 64 * 1024 * 1024;

/** ImageAttempt generationConfig 记录的固定 Alpha 规范化策略。 */
export const professionReferenceImageNormalizationPolicy = {
  schemaVersion: 4,
  minimumWidth: 512,
  minimumHeight: 512,
  maximumPixels: 16 * 1024 * 1024,
  minimumVisibleRatio: 0.03,
  minimumTransparentRatio: 0.1,
  minimumTransparentBorderRatio: 0.8,
  derivedAlpha: {
    luminanceStart: 104,
    luminanceEnd: 176,
    chromaStart: 12,
    chromaEnd: 54,
    transparentSignalMaximum: 0.04,
    opaqueSignalMinimum: 0.96,
  },
  borderDerivedAlpha: {
    cornerSampleRatio: 0.0625,
    minimumCornerSampleSize: 8,
    maximumCornerSampleSize: 64,
    connectedDistanceMaximum: 24,
    transparentDistanceMaximum: 10,
    opaqueDistanceMinimum: 72,
  },
  neutralPaletteDerivedAlpha: {
    sampleBandRatio: 0.04,
    minimumSampleBandSize: 4,
    maximumSampleBandSize: 32,
    maximumChroma: 18,
    quantizationStep: 8,
    maximumPaletteColors: 12,
    minimumNeutralBorderRatio: 0.8,
    minimumPaletteCoverageRatio: 0.8,
    transparentDistanceMaximum: 12,
    opaqueDistanceMinimum: 72,
  },
} as const;

export type ProfessionReferenceImageNormalizationMode =
  | "native-alpha-v3"
  | "dark-derived-alpha-v3"
  | "border-derived-alpha-v3"
  | "neutral-palette-derived-alpha-v4";

export type NormalizeProfessionReferenceImageResult =
  | {
      status: "accepted";
      bytes: Uint8Array;
      mode: ProfessionReferenceImageNormalizationMode;
    }
  | { status: "invalid-png" }
  | { status: "transparency-invalid" };

/**
 * 将模型 PNG 变为可供固定 Aseprite adapter 消费的透明参考母图。
 *
 * 原生 Alpha 图片保留其 Alpha；全不透明图片依次尝试深色信号、四角连通背景和有限中性色板
 * 三种确定性派生候选。四条路径最终都要求存在足量透明/可见像素、外边界主要透明，并清零
 * 完全透明像素的 RGB；任一规则无法证明前景与背景时失败关闭。
 */
export async function normalizeProfessionReferenceImage(
  bytes: Uint8Array,
): Promise<NormalizeProfessionReferenceImageResult> {
  if (
    bytes.byteLength < pngSignature.byteLength ||
    !Buffer.from(bytes)
      .subarray(0, pngSignature.byteLength)
      .equals(pngSignature)
  ) {
    return { status: "invalid-png" };
  }

  let decoded: Awaited<ReturnType<typeof decodeRgba>>;
  try {
    decoded = await decodeRgba(bytes);
  } catch {
    return { status: "invalid-png" };
  }
  const { data, width, height } = decoded;
  if (
    width < professionReferenceImageNormalizationPolicy.minimumWidth ||
    height < professionReferenceImageNormalizationPolicy.minimumHeight
  ) {
    return { status: "transparency-invalid" };
  }

  const selected = selectAlphaCandidate(data, width, height);
  if (!selected) return { status: "transparency-invalid" };
  const { normalized, mode } = selected;
  const changed = clearTransparentRgb(normalized);
  if (mode === "native-alpha-v3" && !changed) {
    return { status: "accepted", bytes: Buffer.from(bytes), mode };
  }

  const encoded = await sharp(normalized, {
    raw: { width, height, channels: 4 },
  })
    .png({ adaptiveFiltering: true, compressionLevel: 9, palette: false })
    .toBuffer();
  if (encoded.byteLength > maximumImageBytes) {
    return { status: "transparency-invalid" };
  }
  return { status: "accepted", bytes: encoded, mode };
}

function selectAlphaCandidate(
  data: Uint8Array,
  width: number,
  height: number,
): {
  normalized: Buffer;
  mode: ProfessionReferenceImageNormalizationMode;
} | null {
  const nativeAlpha = Buffer.from(data);
  if (
    hasAlphaBelowOpaque(nativeAlpha) &&
    hasValidAlphaSemantics(nativeAlpha, width, height)
  ) {
    return { normalized: nativeAlpha, mode: "native-alpha-v3" };
  }

  const darkDerived = deriveDarkAlpha(data);
  if (hasValidAlphaSemantics(darkDerived, width, height)) {
    return { normalized: darkDerived, mode: "dark-derived-alpha-v3" };
  }

  const borderDerived = deriveBorderAlpha(data, width, height);
  if (hasValidAlphaSemantics(borderDerived, width, height)) {
    return { normalized: borderDerived, mode: "border-derived-alpha-v3" };
  }

  const neutralPaletteDerived = deriveNeutralPaletteAlpha(
    data,
    width,
    height,
    professionReferenceImageNormalizationPolicy.neutralPaletteDerivedAlpha,
  );
  return neutralPaletteDerived &&
    hasValidAlphaSemantics(neutralPaletteDerived, width, height)
    ? {
        normalized: neutralPaletteDerived,
        mode: "neutral-palette-derived-alpha-v4",
      }
    : null;
}

async function decodeRgba(bytes: Uint8Array): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  const decoded = await sharp(Buffer.from(bytes), {
    failOn: "warning",
    limitInputPixels: professionReferenceImageNormalizationPolicy.maximumPixels,
    sequentialRead: true,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 4) throw new Error("REFERENCE_RGBA_REQUIRED");
  return {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
  };
}

function hasAlphaBelowOpaque(data: Uint8Array): boolean {
  for (let offset = 3; offset < data.byteLength; offset += 4) {
    if (data[offset] !== 255) return true;
  }
  return false;
}

function deriveDarkAlpha(source: Uint8Array): Buffer {
  const output = Buffer.alloc(source.byteLength);
  const policy = professionReferenceImageNormalizationPolicy.derivedAlpha;
  for (let offset = 0; offset < source.byteLength; offset += 4) {
    const red = source[offset] ?? 0;
    const green = source[offset + 1] ?? 0;
    const blue = source[offset + 2] ?? 0;
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const luminanceSignal = normalizeSignal(
      luminance,
      policy.luminanceStart,
      policy.luminanceEnd,
    );
    const chromaSignal = normalizeSignal(
      maximum - minimum,
      policy.chromaStart,
      policy.chromaEnd,
    );
    const signal = smoothStep(Math.max(luminanceSignal, chromaSignal));
    const alpha =
      signal <= policy.transparentSignalMaximum
        ? 0
        : signal >= policy.opaqueSignalMinimum
          ? 255
          : Math.round(signal * 255);
    output[offset] = red;
    output[offset + 1] = green;
    output[offset + 2] = blue;
    output[offset + 3] = alpha;
  }
  return output;
}

function deriveBorderAlpha(
  source: Uint8Array,
  width: number,
  height: number,
): Buffer {
  const policy = professionReferenceImageNormalizationPolicy.borderDerivedAlpha;
  const sampleSize = Math.max(
    policy.minimumCornerSampleSize,
    Math.min(
      policy.maximumCornerSampleSize,
      Math.round(Math.min(width, height) * policy.cornerSampleRatio),
    ),
  );
  const corners = [
    sampleCornerColor(source, width, 0, 0, sampleSize),
    sampleCornerColor(source, width, width - sampleSize, 0, sampleSize),
    sampleCornerColor(source, width, 0, height - sampleSize, sampleSize),
    sampleCornerColor(
      source,
      width,
      width - sampleSize,
      height - sampleSize,
      sampleSize,
    ),
  ] as const;
  const pixelCount = width * height;
  const distances = new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const xRatio = (index % width) / Math.max(1, width - 1);
    const yRatio = Math.floor(index / width) / Math.max(1, height - 1);
    const expected = interpolateBackground(corners, xRatio, yRatio);
    const offset = index * 4;
    distances[index] = Math.hypot(
      (source[offset] ?? 0) - expected[0],
      (source[offset + 1] ?? 0) - expected[1],
      (source[offset + 2] ?? 0) - expected[2],
    );
  }

  const connectedBackground = findConnectedBackground(
    distances,
    width,
    height,
    policy.connectedDistanceMaximum,
  );
  const output = Buffer.from(source);
  for (let index = 0; index < pixelCount; index += 1) {
    const signal = connectedBackground[index]
      ? 0
      : smoothStep(
          normalizeSignal(
            distances[index] ?? 0,
            policy.transparentDistanceMaximum,
            policy.opaqueDistanceMinimum,
          ),
        );
    output[index * 4 + 3] = Math.round(signal * 255);
  }
  return output;
}

function sampleCornerColor(
  source: Uint8Array,
  width: number,
  startX: number,
  startY: number,
  sampleSize: number,
): readonly [number, number, number] {
  const channels = [[], [], []] as [number[], number[], number[]];
  for (let y = startY; y < startY + sampleSize; y += 1) {
    for (let x = startX; x < startX + sampleSize; x += 1) {
      const offset = (y * width + x) * 4;
      channels[0].push(source[offset] ?? 0);
      channels[1].push(source[offset + 1] ?? 0);
      channels[2].push(source[offset + 2] ?? 0);
    }
  }
  return channels.map((channel) => median(channel)) as [number, number, number];
}

function median(values: number[]): number {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function interpolateBackground(
  corners: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ],
  xRatio: number,
  yRatio: number,
): readonly [number, number, number] {
  return [0, 1, 2].map((channel) => {
    const top =
      (corners[0][channel] ?? 0) * (1 - xRatio) +
      (corners[1][channel] ?? 0) * xRatio;
    const bottom =
      (corners[2][channel] ?? 0) * (1 - xRatio) +
      (corners[3][channel] ?? 0) * xRatio;
    return top * (1 - yRatio) + bottom * yRatio;
  }) as [number, number, number];
}

function findConnectedBackground(
  distances: Float32Array,
  width: number,
  height: number,
  maximumDistance: number,
): Uint8Array {
  const connected = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let queueStart = 0;
  let queueEnd = 0;
  const enqueue = (index: number): void => {
    if (connected[index] || (distances[index] ?? Infinity) > maximumDistance) {
      return;
    }
    connected[index] = 1;
    queue[queueEnd] = index;
    queueEnd += 1;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (queueStart < queueEnd) {
    const index = queue[queueStart] ?? 0;
    queueStart += 1;
    const x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index + width < connected.length) enqueue(index + width);
  }
  return connected;
}

function normalizeSignal(value: number, start: number, end: number): number {
  return Math.max(0, Math.min(1, (value - start) / (end - start)));
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function clearTransparentRgb(data: Buffer): boolean {
  let changed = false;
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    if (
      data[offset + 3] === 0 &&
      (data[offset] !== 0 || data[offset + 1] !== 0 || data[offset + 2] !== 0)
    ) {
      data[offset] = 0;
      data[offset + 1] = 0;
      data[offset + 2] = 0;
      changed = true;
    }
  }
  return changed;
}

function hasValidAlphaSemantics(
  data: Uint8Array,
  width: number,
  height: number,
): boolean {
  const pixelCount = width * height;
  let visiblePixels = 0;
  let transparentPixels = 0;
  let transparentBorderPixels = 0;
  const borderPixelCount = width * 2 + Math.max(0, height - 2) * 2;
  for (let index = 0; index < pixelCount; index += 1) {
    const alpha = data[index * 4 + 3] ?? 0;
    const x = index % width;
    const y = Math.floor(index / width);
    const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    if (alpha === 0) {
      transparentPixels += 1;
      if (border) transparentBorderPixels += 1;
    } else {
      visiblePixels += 1;
    }
  }
  const policy = professionReferenceImageNormalizationPolicy;
  return (
    visiblePixels / pixelCount >= policy.minimumVisibleRatio &&
    transparentPixels / pixelCount >= policy.minimumTransparentRatio &&
    transparentBorderPixels / borderPixelCount >=
      policy.minimumTransparentBorderRatio
  );
}
