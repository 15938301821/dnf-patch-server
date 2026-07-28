/**
 * @fileoverview 解析服务端资源导入使用的逻辑官方来源目录；目录只含 sourceId 与 SHA-256。
 * @module config/resource-import-source-catalog
 * @author AI生成
 * @created 2026-07-27
 * @relatedPlan N/A - 剑魂多官方源资源导入
 *
 * 调用关系：环境 schema 在 Nest 装配前调用本模块；ResourceImportService 只消费解析后的目录并
 * 为每项创建 Inventory v2 Job。输入输出不含本机路径、NPK 字节或 Worker 工具配置。
 * 副作用：纯内存 JSON/Zod 解析，无文件、网络或数据库访问。
 * 安全边界：未知字段、重复 ID、路径字段、无效摘要和超过 64 项都必须阻断服务启动；目录存在
 * 只授权创建声明式 Job，不证明 Worker 本机注册了同一来源或真实 NPK 摘要匹配。
 */
import { z } from "zod";
import { clientIdSchema, sha256Schema } from "../common/contracts/index.js";

export const resourceImportSourceCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z
      .array(
        z
          .object({
            sourceId: clientIdSchema,
            sourceSha256: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((catalog, context) => {
    const sourceIds = catalog.sources.map((source) =>
      source.sourceId.toLocaleLowerCase(),
    );
    if (new Set(sourceIds).size !== sourceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "资源导入来源目录不能包含重复 ID。",
      });
    }
  });

/** 服务端内存中的有序逻辑来源目录；绝对/相对文件路径均不属于该类型。 */
export type ResourceImportSourceCatalog = z.infer<
  typeof resourceImportSourceCatalogSchema
>;

/** 环境变量 JSON 的有界解析 schema；输出直接是可供 Service 消费的目录对象。 */
export const resourceImportSourceCatalogJsonSchema = z
  .string()
  .min(1)
  .max(65_536)
  .transform((text, context): ResourceImportSourceCatalog => {
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "来源目录必须是有效 JSON。",
      });
      return z.NEVER;
    }
    const result = resourceImportSourceCatalogSchema.safeParse(input);
    if (!result.success) {
      context.addIssue({
        code: "custom",
        message: "来源目录不符合严格逻辑身份契约。",
      });
      return z.NEVER;
    }
    return {
      schemaVersion: 1,
      sources: result.data.sources.map((source) => ({
        sourceId: source.sourceId,
        sourceSha256: source.sourceSha256.toUpperCase(),
      })),
    };
  });
