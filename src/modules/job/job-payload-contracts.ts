/**
 * @fileoverview 将 Factory 冻结的 Job kind/schemaVersion 映射为已注册的声明式 payload schema；不从数据库
 * 读取 Factory、不创建 Job、不执行 Worker，也不接受命令、脚本、路径或资源正文。
 * @module modules/job/payload-contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：RunService 读取 Factory v2 的 jobContracts 后调用 parseJobPayload；JobRepository claim 时的
 * 完整性检查也使用同一契约防止持久化 JSON 被绕过。Guardrail 的 declarativeParametersSchema 提供递归
 * 执行入口/路径拒绝语义。
 * 输入输出：输入是受控 kind、Factory 注册版本与未知 JSON；输出是对应的已解析联合类型，失败时抛出 Zod/
 * 注册错误，不返回 Worker 命令、工具路径、游戏资源或数据库信息。
 * 副作用：纯内存 schema 解析，无网络、数据库、对象存储、事件或进程副作用。
 * 安全边界：kind 在 enum 中出现不等于可任意解析；仅 schemaVersion=1 且本表显式注册的契约可接受。
 * `profession`、`shared-fx` 使用更具体的冻结 payload，其他 kind 只能使用有界声明式 v1 结构。
 */
import { z } from "zod";
import { clientIdSchema } from "../../common/contracts/index.js";
import {
  declarativeParametersSchema,
  type AllowedJobKind,
} from "../guardrail/guardrail.contracts.js";
import { styleSkillProductionJobPayloadV2Schema } from "./style-skill-production.contracts.js";
import { sharedFxJobPayloadV1Schema } from "./shared-fx.contracts.js";

/**
 * 大多数受控 Job kind 共用的声明式 payload v1。
 * parameters 由 Guardrail 递归限制，不能借 profile/parameters 混入可执行入口；资源映射仍由其他已验证事实源提供。
 */
const declarativeJobPayloadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: clientIdSchema,
    parameters: declarativeParametersSchema,
  })
  .strict();

/** 已通过通用 v1 声明式 schema 的 payload，不包含工具命令、绝对路径或资源正文。 */
export type DeclarativeJobPayloadV1 = z.infer<
  typeof declarativeJobPayloadV1Schema
>;

/**
 * 当前注册表能返回的所有 payload 联合类型。
 * 名称中的 V1 指 Factory contract 的注册版本；其中 profession 的业务 payload 自身可包含更细的版本字段。
 */
export type RegisteredJobPayloadV1 =
  | DeclarativeJobPayloadV1
  | z.infer<typeof styleSkillProductionJobPayloadV2Schema>
  | z.infer<typeof sharedFxJobPayloadV1Schema>;

/**
 * 解析 Factory 已冻结的 Job payload。
 * @param kind Factory 允许的 Job kind；调用方仍需先确认该 kind 位于 Factory.allowedJobKinds。
 * @param schemaVersion Factory jobContracts 中冻结的版本，当前只注册版本 1。
 * @param payload 不可信 JSON，必须在执行前解析；不能从类型断言绕过本函数。
 * @returns 对应 kind 的已解析 RegisteredJobPayloadV1。
 * @throws JOB_PAYLOAD_CONTRACT_NOT_REGISTERED 或 Zod 解析错误，当版本/kind 未注册或字段不安全时抛出。
 * @remarks schema 成功不证明 Worker capability、Artifact、NPK 映射、模型结果或客户端兼容性。
 */
export function parseJobPayload(
  kind: AllowedJobKind,
  schemaVersion: number,
  payload: unknown,
): RegisteredJobPayloadV1 {
  if (schemaVersion !== 1) {
    throw new Error("JOB_PAYLOAD_CONTRACT_NOT_REGISTERED");
  }
  if (kind === "profession") {
    return styleSkillProductionJobPayloadV2Schema.parse(payload);
  }
  if (kind === "shared-fx") {
    return sharedFxJobPayloadV1Schema.parse(payload);
  }
  return registeredContracts[kind].parse(payload);
}

/**
 * 除 profession/shared-fx 外使用通用 v1 schema 的显式白名单。
 * 使用完整 Record 使新增 AllowedJobKind 时 TypeScript 强制维护者登记契约，而不会默认放行未知 kind。
 */
const registeredContracts: Record<
  Exclude<AllowedJobKind, "profession" | "shared-fx">,
  typeof declarativeJobPayloadV1Schema
> = {
  "context-freeze": declarativeJobPayloadV1Schema,
  inventory: declarativeJobPayloadV1Schema,
  "engineering-plan": declarativeJobPayloadV1Schema,
  "image-reference": declarativeJobPayloadV1Schema,
  "aseprite-adaptation": declarativeJobPayloadV1Schema,
  "npk-package": declarativeJobPayloadV1Schema,
  "independent-validation": declarativeJobPayloadV1Schema,
  "manual-review": declarativeJobPayloadV1Schema,
  "bpk-package": declarativeJobPayloadV1Schema,
};
