/**
 * @fileoverview 定义 Project、Project Snapshot 的严格输入与公开 ViewModel；不负责 Factory 存在性、
 * 数据库写入、用户资源所有权、Run 创建或 Worker 调度。
 * @module modules/project/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ProjectController 使用 schema 解析浏览器 DTO；ProjectService/Repository 使用推导类型创建、
 * 查询和映射项目；Run 创建链路随后引用已保存的 Project 与 Snapshot。
 * 输入输出：输入是 Factory 关联、显示名称和开发期规则/manifest/prompt/tool 摘要；输出为脱敏的
 * ProjectView 或 ProjectSnapshotView，不包含源码、Prompt 内容、对象路径、Worker 令牌或数据库行。
 * 副作用：本文件只做内存校验，不访问数据库、对象存储、游戏资源或本机工具。
 * 安全边界：Snapshot 保存的是带 SHA-256 的事实引用而不是运行时读取仓库的授权；
 * fullSkillCoverageProven 固定为 false，不能由浏览器、Worker、模型或 Snapshot 输入提升。
 */
import { z } from "zod";
import {
  clientIdSchema,
  idSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

/**
 * 创建 Project 的严格浏览器 DTO。
 * clientProjectId 只是客户端幂等/关联标识，不替代服务器生成 id、Factory 验证或规范化名称冲突检查。
 */
export const createProjectSchema = z
  .object({
    factoryId: clientIdSchema,
    clientProjectId: clientIdSchema.optional(),
    displayName: safeDisplayNameSchema,
  })
  .strict();

/**
 * 将开发期 DNF 规则、manifest、prompt 树与工具目录冻结为摘要引用的严格 DTO。
 * 该 schema 不读取对应文件，也不因摘要格式正确就证明资源映射、全技能覆盖或客户端兼容性。
 */
export const projectSnapshotSchema = z
  .object({
    clientSnapshotId: clientIdSchema,
    rootRulesSha256: sha256Schema,
    manifestSha256: sha256Schema.optional(),
    promptTreeSha256: sha256Schema,
    toolCatalogSha256: sha256Schema,
    repositoryRevision: z.string().max(80).optional(),
    fullSkillCoverageProven: z.literal(false).default(false),
  })
  .strict();

/** 经 createProjectSchema 解析的创建输入，不等同于持久化 Project 行。 */
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/** 经 projectSnapshotSchema 解析的冻结摘要输入，不包含实际规则、Prompt 或工具文件。 */
export type CreateProjectSnapshotInput = z.infer<typeof projectSnapshotSchema>;

/**
 * 浏览器与领域 Service 可消费的 Project ViewModel。
 * 当前模型不含用户归属字段；调用方不能仅凭此响应推断跨用户访问授权已处理。
 */
export interface ProjectView {
  id: string;
  factoryId: string;
  clientProjectId?: string;
  displayName: string;
  canonicalName: string;
  version: number;
  archived: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
}

/**
 * 已持久化 Snapshot 的公开 ViewModel，保存来源摘要而非开发期文件本体。
 * `fullSkillCoverageProven` 始终为 false，且本 ViewModel 不表示可部署或客户端兼容。
 */
export interface ProjectSnapshotView extends CreateProjectSnapshotInput {
  id: string;
  projectId: string;
  createdAtUtc: string;
}

/** Project 路由和跨模块引用使用的服务器 id schema，不接受客户端显示名称作为身份。 */
export const projectIdSchema = idSchema;
