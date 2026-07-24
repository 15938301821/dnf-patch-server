/**
 * @fileoverview 定义 Worker 读取冻结 Profession 技能源事实时的脱敏 ViewModel；不包含对象 key、
 * 下载 URL、Prompt、模型配置、本机路径、命令或源帧正文。
 * @module modules/job/profession-source-context-contracts
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：内部 Controller 复用 Profession 执行的四字段 lease DTO，并用本文件 schema 严格校验
 * Service 返回值；Worker 的对应线协议消费该 ViewModel。输入输出只在内存中解析，无数据库或网络副作用。
 * 安全边界：响应只提供 Worker 与本机只读官方 NPK 交叉核对所需的来源摘要、内部 IMG 相对路径和
 * 结构证据；未知字段、绝对路径、父目录段、控制字符、重复来源或非大写摘要一律 fail-closed。
 */
import { z } from "zod";
import {
  repositoryRelativePathSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

const maxSourceFrameManifestBytes = 64 * 1024 * 1024;
const uppercaseSha256Schema = sha256Schema.regex(/^[A-F0-9]{64}$/u);

/** 服务端冻结并规范化的 NPK 内部 IMG 路径；它不是 Worker 或 Server 的文件系统路径。 */
const npkInternalPathViewSchema = repositoryRelativePathSchema.refine(
  (value) => {
    const normalized = value.replaceAll("\\", "/");
    return (
      normalized === normalized.normalize("NFC").toLowerCase() &&
      !normalized.split("/").some((segment) => segment.length === 0) &&
      !Array.from(normalized).some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
        );
      })
    );
  },
  { message: "NPK 内部路径必须是规范化的安全相对路径。" },
);

/** Worker 可见的单个冻结 IMG 来源；元数据摘要必须与 Job payload 中对应 Entry 一致。 */
const professionSkillSourceEntryViewSchema = z
  .object({
    sourceInventoryEntryId: z.uuid(),
    internalPath: npkInternalPathViewSchema,
    imgVersion: z.number().int().min(1).max(6),
    frameCount: z.number().int().min(0).max(1_000_000),
    metadataSha256: uppercaseSha256Schema,
  })
  .strict();

/**
 * 当前 lease 下单个技能的冻结源上下文。
 * `source` 只标识 Worker 本机应匹配的只读官方 NPK；`frameManifest` 只给出重新扫描后可复算的
 * JSON 证据身份；`entries` 保留 Job 冻结顺序，不授权访问其他 Inventory Entry。
 */
export const professionSkillSourceContextViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    skillId: z.uuid(),
    source: z
      .object({
        runId: z.uuid(),
        inventoryId: z.uuid(),
        byteLength: z.number().int().positive().max(4_294_967_295),
        sha256: uppercaseSha256Schema,
      })
      .strict(),
    frameManifest: z
      .object({
        artifactId: z.uuid(),
        mediaType: z.literal("application/json"),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(maxSourceFrameManifestBytes),
        sha256: uppercaseSha256Schema,
        toolSha256: uppercaseSha256Schema,
      })
      .strict(),
    entries: z.array(professionSkillSourceEntryViewSchema).min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const entryIds = value.entries.map((entry) => entry.sourceInventoryEntryId);
    const paths = value.entries.map((entry) => entry.internalPath);
    if (new Set(entryIds).size !== entryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "冻结技能源不能包含重复 Inventory Entry。",
      });
    }
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "冻结技能源不能包含重复 IMG 路径。",
      });
    }
  });

/** 发送给受控 Worker 的冻结技能源 ViewModel，不证明源帧已导出、Aseprite 已执行或 NPK 已构建。 */
export type ProfessionSkillSourceContextView = z.infer<
  typeof professionSkillSourceContextViewSchema
>;
