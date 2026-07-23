/**
 * @fileoverview 定义 Factory 的版本化冻结配置、创建输入与只读响应契约；不负责持久化、HTTP 路由、
 * Job 创建或运行时执行。
 * @module modules/factory/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：FactoryController 用本文件的 Zod schema 校验浏览器输入；FactoryService 与
 * FactoryRepository 使用推导类型保存和读取配置；Run 创建链路随后只消费已冻结的 Factory ViewModel。
 * 输入输出：输入是浏览器提交的版本、策略、profile、允许 Job kind 和内容哈希；输出是对客户端安全的
 * FactoryView，不是 Drizzle 数据库行或 Worker 可执行指令。
 * 副作用：本文件没有网络、数据库或任务副作用，只在解析边界拒绝未知字段和不一致配置。
 * 安全边界：Factory 只允许声明式 Job 白名单；arbitraryExecution 与 deploymentAuthorized 必须保持
 * false。v2 的 policy 哈希和逐 kind contract 必须完整冻结，缺失证据时由下游 fail-closed。
 */
import { z } from "zod";
import {
  clientIdSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";

/** 限制 Factory 的 Job 白名单为无重复的受控 kind，不能据此声明所有 kind 都已有 Worker 实现。 */
const allowedJobKindsSchema = z
  .array(allowedJobKindSchema)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "allowedJobKinds 不能包含重复项。",
  });

/** 仅用于读取历史 Factory 的 v1 配置；新 Run 的创建链路不能把它当作可写冻结版本。 */
const factoryConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: clientIdSchema,
    policyId: clientIdSchema,
    allowedJobKinds: allowedJobKindsSchema,
    arbitraryExecution: z.literal(false).default(false),
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict();

/**
 * 当前可创建 Run 的 v2 冻结配置。
 * policySha256 和 jobContracts 让 Service 能证明每个允许 Job kind 有对应的版本化声明式契约，
 * 而不是按名称猜测 Worker 能执行什么。
 */
const factoryConfigV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    profileId: clientIdSchema,
    policyId: clientIdSchema,
    policySha256: sha256Schema,
    allowedJobKinds: allowedJobKindsSchema,
    jobContracts: z
      .array(
        z
          .object({
            kind: allowedJobKindSchema,
            schemaVersion: z.literal(1),
          })
          .strict(),
      )
      .min(1),
    arbitraryExecution: z.literal(false).default(false),
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict()
  .superRefine((value, context) => {
    // Job contract 必须与白名单一一对应，避免有允许 kind 缺少可验证 payload 契约或出现隐藏 kind。
    const contractKinds = value.jobContracts.map((contract) => contract.kind);
    if (new Set(contractKinds).size !== contractKinds.length) {
      context.addIssue({
        code: "custom",
        path: ["jobContracts"],
        message: "jobContracts 不能包含重复 kind。",
      });
    }
    const expected = [...value.allowedJobKinds].sort();
    const actual = [...contractKinds].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      context.addIssue({
        code: "custom",
        path: ["jobContracts"],
        message: "jobContracts 必须与 allowedJobKinds 完全对应。",
      });
    }
  });

/**
 * Factory 配置的读取/写入入口 schema。
 * schemaVersion 是判别字段：v1 保留给历史读取，v2 才包含创建新 Run 所需的策略哈希和逐 kind 契约。
 */
export const factoryConfigSchema = z.discriminatedUnion("schemaVersion", [
  factoryConfigV1Schema,
  factoryConfigV2Schema,
]);

/**
 * 浏览器创建 Factory 的严格输入 schema。
 * Controller 在进入 Service 前解析此 DTO（Data Transfer Object，数据传输对象）；configSha256 会在
 * Service 中用规范化 JSON 重新计算，不能只相信客户端提供的摘要。
 */
export const createFactorySchema = z
  .object({
    id: clientIdSchema,
    version: z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/u),
    displayName: safeDisplayNameSchema,
    config: factoryConfigSchema,
    configSha256: sha256Schema,
  })
  .strict();

/** 由 createFactorySchema 校验后的创建输入，不等于数据库持久化行。 */
export type CreateFactoryInput = z.infer<typeof createFactorySchema>;

/** Factory 的版本化声明式配置；v1 与 v2 的差异必须由调用方按 schemaVersion 处理。 */
export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

/**
 * 返回给浏览器和其他领域 Service 的脱敏 Factory ViewModel。
 * config 是已校验的冻结策略，不包含数据库内部时间类型、行锁信息或 Worker token。
 */
export interface FactoryView {
  id: string;
  version: string;
  displayName: string;
  config: FactoryConfig;
  configSha256: string;
  enabled: boolean;
  createdAtUtc: string;
}
