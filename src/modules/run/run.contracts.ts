/**
 * @fileoverview 定义 Run 创建、幂等键、事件查询/订阅、outbox 与公开 ViewModel 契约；不创建数据库记录、
 * 不分发 WebSocket 事件、不执行 Worker Job 或模型调用。
 * @module modules/run/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：RunController 用 createRunSchema、idempotencyKeySchema 和 runEventQuerySchema 解析 REST 请求；
 * RunGateway 用 runSubscriptionSchema 解析 Socket 订阅；RunService/Repository 使用推导类型创建 Run、
 * 权威事件和 outbox，Dispatcher 在提交后消费 outbox。
 * 输入输出：输入是 Project/Snapshot、冻结策略、声明式 Job、请求证据和有限查询数据；输出是脱敏 Run/Event
 * ViewModel，不包含数据库行、Worker 令牌、本机路径、可执行命令、模型密钥或对象存储 URL。
 * 副作用：本文件只做内存 schema 校验和类型推导，不访问数据库、网络、Worker 或游戏资源。
 * 安全边界：serverConnectionEnabled 固定 true，部署/覆盖/兼容性状态固定 false；Job payload 必须由下游按
 * Factory v2 的逐 kind contract 再次解析。schema 成功不代表 Project/Snapshot/Factory 归属、Guardrail、
 * Worker capability、Artifact 证据或客户端兼容已证明。
 */
import { z } from "zod";
import { clientIdSchema, sha256Schema } from "../../common/contracts/index.js";
import { createJobSchema } from "../job/job.contracts.js";

/**
 * 创建 Run 的严格 REST DTO。
 * `requestSha256` 是客户端提交的证据摘要，Service 还会计算覆盖完整已解析请求和 owner 的服务器幂等指纹；
 * `jobs` 仅携带声明式 payload，实际 schemaVersion/profile/策略绑定必须在 Factory contract 路径复核。
 */
export const createRunSchema = z
  .object({
    projectId: z.uuid(),
    snapshotId: z.uuid(),
    clientRunId: clientIdSchema,
    action: z.enum([
      "create-profession",
      "create-theme",
      "generate-patch",
      "generate-shared-fx",
      "validate-only",
      "package-bpk",
      "import-resources",
    ]),
    requestSha256: sha256Schema,
    serverConnectionEnabled: z.literal(true).default(true),
    modelEgressAuthorized: z.boolean().default(false),
    deploymentAuthorized: z.literal(false).default(false),
    deploymentPerformed: z.literal(false).default(false),
    fullSkillCoverageProven: z.literal(false).default(false),
    clientCompatibilityProven: z.literal(false).default(false),
    jobs: z.array(createJobSchema).min(1).max(64),
    policyId: clientIdSchema,
    policySha256: sha256Schema,
  })
  .strict();

/**
 * HTTP Idempotency-Key 的受限格式。
 * 键只在同一 Project 范围内复用；相同键的安全重放还要求服务器请求指纹完全一致，不能仅看键字符串。
 */
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u);

/**
 * 读取权威 Run 事件流的分页 DTO。
 * sequence 是单个 Run 内递增序号，afterSequence=-1 表示从开始读取；limit 上限防止事件恢复接口无界查询。
 */
export const runEventQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().min(-1).default(-1),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();

/**
 * WebSocket `run:subscribe` 消息的严格 DTO。
 * Socket 身份在 Gateway middleware 单独验证；本 schema 只约束 Run 标识与事件恢复起点，不能授予资源访问权。
 */
export const runSubscriptionSchema = z
  .object({
    runId: z.uuid(),
    afterSequence: z.number().int().min(-1).default(-1),
  })
  .strict();

/**
 * 已提交权威 Run Event 的公开线协议。
 * evidenceArtifactId 只引用已知证据，不携带 Artifact 内容或下载 URL；事件顺序应以同一 Run 的 sequence 为准。
 */
export const runEventSchema = z
  .object({
    runId: z.uuid(),
    sequence: z.number().int().min(0),
    level: z.enum(["info", "warning", "error"]),
    stage: z.string().trim().min(1).max(96),
    message: z.string().trim().min(1).max(2_000),
    evidenceArtifactId: z.uuid().optional(),
    createdAtUtc: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * 事务提交后由 outbox dispatcher 分发的 Run Event 包装契约。
 * aggregateId 与 payload.runId 必须相同，防止一个 Run 的事件被广播到另一个 Run 的订阅房间。
 */
export const runEventOutboxSchema = z
  .object({
    id: z.uuid(),
    topic: z.literal("run.event"),
    aggregateId: z.uuid(),
    payload: runEventSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.aggregateId !== value.payload.runId) {
      context.addIssue({
        code: "custom",
        path: ["aggregateId"],
        message: "Outbox aggregateId 必须与 Run Event 的 runId 一致。",
      });
    }
  });

/** Controller 解析后的创建输入，不等于可直接持久化的 Run 行或 Worker 执行计划。 */
export type CreateRunInput = z.infer<typeof createRunSchema>;

/** 权威事件查询的边界参数，供 Repository 执行受限 sequence 分页。 */
export type RunEventQuery = z.infer<typeof runEventQuerySchema>;

/** WebSocket 订阅输入，只声明恢复位置，不包含认证 token 或订阅授权结果。 */
export type RunSubscription = z.infer<typeof runSubscriptionSchema>;

/** Run 事件 outbox 的已解析消息形状，Dispatcher 必须在事务提交后才广播。 */
export type RunEventOutbox = z.infer<typeof runEventOutboxSchema>;

/**
 * 面向浏览器与跨模块 Service 的脱敏 Run ViewModel。
 * `status`/`currentStage` 是持久化状态摘要，不代替 Job/attempt/lease 细节；所有部署与证明字段保持 false。
 */
export interface RunView {
  id: string;
  projectId: string;
  snapshotId: string;
  clientRunId: string;
  action: string;
  status: string;
  currentStage: string;
  requestSha256: string;
  serverConnectionEnabled: true;
  modelEgressAuthorized: boolean;
  deploymentAuthorized: false;
  deploymentPerformed: false;
  fullSkillCoverageProven: false;
  clientCompatibilityProven: false;
  createdAtUtc: string;
  updatedAtUtc: string;
  finishedAtUtc?: string;
}

/**
 * 仅供受控内部调用的创建选项。
 * deferJobDispatch 用于先持久化 Run 再写入依赖计划的流程；ownerUserId 进入幂等指纹与持久化归属，
 * 不能由普通创建 DTO 自行提交。
 */
export interface RunCreateOptions {
  deferJobDispatch?: boolean;
  ownerUserId?: string;
}

/**
 * OpenAI 固定角色调用读取的最小 Run 上下文。
 * 不包含模型凭据、Prompt、Job payload 或 Project 资源；ownerUserId 存在时下游仍需执行用户配置所有权校验。
 */
export interface RunModelContext {
  modelEgressAuthorized: boolean;
  ownerUserId?: string;
}

/** 已通过 runEventSchema 的公开权威事件 ViewModel。 */
export type RunEventView = z.infer<typeof runEventSchema>;
