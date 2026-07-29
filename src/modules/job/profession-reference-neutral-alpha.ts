/**
 * @fileoverview 从模型展示用的中性多色边界派生 Alpha；不解码、编码或持久化图片。
 * @module modules/job/profession-reference-neutral-alpha
 * @author AI生成
 * @created 2026-07-29
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Profession 参考图规范化器在原生 Alpha、深色画布和渐变画布候选均不合格时调用。
 * 输入输出：输入为已解码 RGBA 与固定策略，输出为候选 RGBA；调用方仍须执行统一 Alpha 语义门禁。
 * 副作用：仅分配有界内存，不访问模型、数据库或对象存储。
 * 安全边界：仅当外边带主要由低色度颜色组成时工作，彩色场景不得被猜测为透明背景。
 */

export interface NeutralPaletteAlphaPolicy {
  sampleBandRatio: number;
  minimumSampleBandSize: number;
  maximumSampleBandSize: number;
  maximumChroma: number;
  quantizationStep: number;
  maximumPaletteColors: number;
  minimumNeutralBorderRatio: number;
  minimumPaletteCoverageRatio: number;
  transparentDistanceMaximum: number;
  opaqueDistanceMinimum: number;
}

interface ColorBucket {
  count: number;
  redTotal: number;
  greenTotal: number;
  blueTotal: number;
}

/**
 * 从外边带的有限中性色调色板生成软 Alpha 候选。
 *
 * 亮灰棋盘等展示背景会形成少量高覆盖颜色；真实彩色场景或高噪声边界因中性色比例、调色板
 * 覆盖率不足而返回 null。返回非 null 也不代表可接受，调用方仍会验证可见、透明和透明边界比例。
 */
export function deriveNeutralPaletteAlpha(
  source: Uint8Array,
  width: number,
  height: number,
  policy: NeutralPaletteAlphaPolicy,
): Buffer | null {
  const bandSize = Math.max(
    policy.minimumSampleBandSize,
    Math.min(
      policy.maximumSampleBandSize,
      Math.round(Math.min(width, height) * policy.sampleBandRatio),
    ),
  );
  const buckets = new Map<string, ColorBucket>();
  let borderPixels = 0;
  let neutralPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (
        x >= bandSize &&
        x < width - bandSize &&
        y >= bandSize &&
        y < height - bandSize
      ) {
        continue;
      }
      borderPixels += 1;
      const offset = (y * width + x) * 4;
      const red = source[offset] ?? 0;
      const green = source[offset + 1] ?? 0;
      const blue = source[offset + 2] ?? 0;
      if (
        Math.max(red, green, blue) - Math.min(red, green, blue) >
        policy.maximumChroma
      ) {
        continue;
      }
      neutralPixels += 1;
      const key = quantizedColorKey(red, green, blue, policy.quantizationStep);
      const bucket = buckets.get(key) ?? {
        count: 0,
        redTotal: 0,
        greenTotal: 0,
        blueTotal: 0,
      };
      bucket.count += 1;
      bucket.redTotal += red;
      bucket.greenTotal += green;
      bucket.blueTotal += blue;
      buckets.set(key, bucket);
    }
  }
  if (
    borderPixels === 0 ||
    neutralPixels / borderPixels < policy.minimumNeutralBorderRatio
  ) {
    return null;
  }

  const selected = [...buckets.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, policy.maximumPaletteColors);
  const coveredPixels = selected.reduce(
    (total, bucket) => total + bucket.count,
    0,
  );
  if (
    neutralPixels === 0 ||
    coveredPixels / neutralPixels < policy.minimumPaletteCoverageRatio
  ) {
    return null;
  }
  const palette = selected.map((bucket): readonly [number, number, number] => [
    bucket.redTotal / bucket.count,
    bucket.greenTotal / bucket.count,
    bucket.blueTotal / bucket.count,
  ]);
  const output = Buffer.from(source);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const distance = nearestColorDistance(
      source[offset] ?? 0,
      source[offset + 1] ?? 0,
      source[offset + 2] ?? 0,
      palette,
    );
    const normalized = Math.max(
      0,
      Math.min(
        1,
        (distance - policy.transparentDistanceMaximum) /
          (policy.opaqueDistanceMinimum - policy.transparentDistanceMaximum),
      ),
    );
    const signal = normalized * normalized * (3 - 2 * normalized);
    output[offset + 3] = Math.round(signal * 255);
  }
  return output;
}

function quantizedColorKey(
  red: number,
  green: number,
  blue: number,
  step: number,
): string {
  return [
    Math.floor(red / step),
    Math.floor(green / step),
    Math.floor(blue / step),
  ].join(",");
}

function nearestColorDistance(
  red: number,
  green: number,
  blue: number,
  palette: readonly (readonly [number, number, number])[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    nearest = Math.min(
      nearest,
      Math.hypot(red - color[0], green - color[1], blue - color[2]),
    );
  }
  return nearest;
}
