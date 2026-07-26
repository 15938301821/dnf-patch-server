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
import {
  allowedJobKindSchema,
  type AllowedJobKind,
} from "../guardrail/guardrail.contracts.js";

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

/** v2 Factory 的 Job contract；profileId 仍由历史顶层字段统一提供。 */
const factoryJobContractV2Schema = z
  .object({
    kind: allowedJobKindSchema,
    schemaVersion: z.literal(1),
  })
  .strict();

/** v3 Factory 的 Job contract；每个 kind 独立冻结自己的本机工具 profile。 */
const factoryJobContractV3Schema = factoryJobContractV2Schema.extend({
  profileId: clientIdSchema,
});

/** 拒绝 Job 白名单与 contract 集合不一致，防止未登记契约的 kind 进入 Run。 */
function validateJobContractKinds(
  allowedJobKinds: readonly AllowedJobKind[],
  jobContracts: ReadonlyArray<{ kind: AllowedJobKind }>,
  context: z.RefinementCtx,
): void {
  const contractKinds = jobContracts.map((contract) => contract.kind);
  if (new Set(contractKinds).size !== contractKinds.length) {
    context.addIssue({
      code: "custom",
      path: ["jobContracts"],
      message: "jobContracts 不能包含重复 kind。",
    });
  }
  const expected = [...allowedJobKinds].sort();
  const actual = [...contractKinds].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    context.addIssue({
      code: "custom",
      path: ["jobContracts"],
      message: "jobContracts 必须与 allowedJobKinds 完全对应。",
    });
  }
}

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
    jobContracts: z.array(factoryJobContractV2Schema).min(1),
    arbitraryExecution: z.literal(false).default(false),
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict()
  .superRefine((value, context) => {
    // Job contract 必须与白名单一一对应，避免有允许 kind 缺少可验证 payload 契约或出现隐藏 kind。
    validateJobContractKinds(
      value.allowedJobKinds,
      value.jobContracts,
      context,
    );
  });

/**
 * 当前可创建多工具链 Run 的 v3 冻结配置。
 * profileId 下沉到逐 kind contract，避免 Inventory 与 Profession 被迫共享同一个本机工具身份。
 */
const factoryConfigV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    policyId: clientIdSchema,
    policySha256: sha256Schema,
    allowedJobKinds: allowedJobKindsSchema,
    jobContracts: z.array(factoryJobContractV3Schema).min(1),
    arbitraryExecution: z.literal(false).default(false),
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict()
  .superRefine((value, context) => {
    validateJobContractKinds(
      value.allowedJobKinds,
      value.jobContracts,
      context,
    );
  });

/**
 * Factory 配置的读取/写入入口 schema。
 * SchemaVersion 是判别字段：v1 保留给历史读取，v2 保留单 profile 兼容；v3 为每个 Job kind
 * 冻结独立 profile。只有 v2/v3 可进入新 Run 创建链路。
 */
export const factoryConfigSchema = z.discriminatedUnion("schemaVersion", [
  factoryConfigV1Schema,
  factoryConfigV2Schema,
  factoryConfigV3Schema,
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

/** Factory 的版本化声明式配置；调用方必须按 schemaVersion 处理历史读取与可运行版本。 */
export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

/** v2/v3 中解析后的单个 Job contract；profileId 始终与当前 kind 精确绑定。 */
export interface ResolvedFactoryJobContract {
  kind: AllowedJobKind;
  schemaVersion: 1;
  profileId: string;
}

/**
 * 解析一个已冻结 Factory 中指定 Job kind 的版本与工具 profile。
 * @param config 已由 factoryConfigSchema 校验的配置；v1 只读配置不会产生可运行 contract。
 * @param kind 当前准备创建或复核的受控 Job kind。
 * @returns 白名单与 contract 同时存在时返回统一结果，否则返回 undefined 并由调用方 fail-closed。
 */
export function resolveFactoryJobContract(
  config: FactoryConfig,
  kind: AllowedJobKind,
): ResolvedFactoryJobContract | undefined {
  if (config.schemaVersion === 1 || !config.allowedJobKinds.includes(kind)) {
    return undefined;
  }
  if (config.schemaVersion === 2) {
    const contract = config.jobContracts.find(
      (candidate) => candidate.kind === kind,
    );
    return contract
      ? {
          kind,
          schemaVersion: contract.schemaVersion,
          profileId: config.profileId,
        }
      : undefined;
  }
  const contract = config.jobContracts.find(
    (candidate) => candidate.kind === kind,
  );
  return contract
    ? {
        kind,
        schemaVersion: contract.schemaVersion,
        profileId: contract.profileId,
      }
    : undefined;
}

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
