/**
 * @fileoverview 根据Server已持久化的逐帧证据独立复算Profession V6 target-set摘要；
 * 不查询数据库、不读取Artifact正文，也不信任Worker自报摘要。
 * @module modules/job/profession-v6-target-set
 * @author AI生成
 * @created 2026-08-01
 * @relatedPlan N/A - 用户直接要求实现Profession V6
 *
 * 调用关系：单技能passed接收事务按官方frameOrdinal锁定数据库行后调用本纯函数；下游使用
 * common JCS v1计算确定性SHA-256。输入是同一技能的全部generate帧，输出为大写摘要。
 * 副作用：无数据库、网络或对象存储访问。失败路径：字段越界、空集合或身份复用时抛出，事务
 * 必须将其映射为证据不匹配并禁止写passed。
 * 安全边界：数组顺序属于摘要协议；调用方必须按官方顺序传入。Artifact、ModelCall和
 * ImageAttempt是逐帧独立身份，任一复用都fail-closed，不能合并跨attempt结果。
 */
import { z } from "zod";
import { sha256JcsV1 } from "../../common/utils/canonical.js";

const uppercaseSha256Schema = z.string().regex(/^[A-F0-9]{64}$/u);
const coordinateSchema = z.number().int().min(0).max(1_000_000);

const professionV6TargetSetFrameSchema = z
  .object({
    entryIndex: coordinateSchema,
    frameIndex: coordinateSchema,
    width: z.number().int().positive().max(1_000_000),
    height: z.number().int().positive().max(1_000_000),
    artifactId: z.uuid(),
    modelCallId: z.uuid(),
    imageAttemptId: z.uuid(),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
    sha256: uppercaseSha256Schema,
    sourceAlphaSha256: uppercaseSha256Schema,
  })
  .strict();

const professionV6TargetSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("profession-v6-target-set-v1"),
    skillId: z.uuid(),
    frames: z.array(professionV6TargetSetFrameSchema).min(1).max(2_048),
  })
  .strict();

/** Server复算target-set所需的单帧最小证据；本机路径和数据库时间不得进入摘要。 */
export type ProfessionV6TargetSetFrameEvidence = z.input<
  typeof professionV6TargetSetFrameSchema
>;

/**
 * 计算完整V6模型目标集合的规范摘要。
 * @param skillId 冻结Job中已校验的技能UUID。
 * @param frames 事务按官方frameOrdinal排列的全部generate帧数据库证据。
 * @returns 与Worker V6协议一致的大写JCS v1 SHA-256；不证明Artifact正文已读取或客户端兼容。
 * @throws ZodError 当字段、数量或大小越界；重复身份抛出PROFESSION_V6_TARGET_SET_DUPLICATED。
 */
export function createProfessionV6TargetSetSha256(
  skillId: string,
  frames: readonly ProfessionV6TargetSetFrameEvidence[],
): string {
  const coordinates = new Set<string>();
  const artifactIds = new Set<string>();
  const modelCallIds = new Set<string>();
  const imageAttemptIds = new Set<string>();
  const canonicalFrames = frames.map((frame) => {
    const canonical = professionV6TargetSetFrameSchema.parse(frame);
    const coordinate = [
      String(canonical.entryIndex),
      String(canonical.frameIndex),
    ].join(":");
    if (
      coordinates.has(coordinate) ||
      artifactIds.has(canonical.artifactId) ||
      modelCallIds.has(canonical.modelCallId) ||
      imageAttemptIds.has(canonical.imageAttemptId)
    ) {
      throw new Error("PROFESSION_V6_TARGET_SET_DUPLICATED");
    }
    coordinates.add(coordinate);
    artifactIds.add(canonical.artifactId);
    modelCallIds.add(canonical.modelCallId);
    imageAttemptIds.add(canonical.imageAttemptId);
    return canonical;
  });
  return sha256JcsV1(
    professionV6TargetSetSchema.parse({
      schemaVersion: 1,
      kind: "profession-v6-target-set-v1",
      skillId,
      frames: canonicalFrames,
    }),
  );
}
