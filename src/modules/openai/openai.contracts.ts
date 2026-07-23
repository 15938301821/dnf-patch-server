/**
 * @fileoverview 定义固定角色模型调用的内存输入、脱敏审计 ViewModel 与返回结果；不负责 HTTP DTO 校验、用户凭据保存、Provider 网络请求或数据库表映射。
 * @module modules/openai
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Run 等领域 Service 组织已验证的业务上下文后调用 OpenAiService；Service 使用这些
 * 契约向 OpenAiProvider 发送固定角色请求，并将 ModelCallView 交给 Repository 持久化审计事实。
 * 输入输出：请求中的 runId、角色、指令和受限输入来自服务端已冻结的业务流程；结果只返回解析值、
 * 短暂图片字节或脱敏审计视图，不返回 API Key、密文、Provider 原始响应或 Worker token。
 * 副作用：本文件仅声明类型和 Zod schema 泛型，不执行数据库、网络、对象存储或 Worker 租约操作。
 * 安全边界：model egress（模型出站）是服务向用户配置的模型端点发送数据的受控动作，必须由
 * Run 授权、稳定用户所有权和配置解析共同决定；这些类型不代表授权已完成，也不能被用来选择任意
 * endpoint、工具或存储策略。Worker token 与 lease（Worker 对 Job 的限时执行权及 fencing 编号）
 * 不属于模型调用协议，不能通过这些契约传递。
 * 术语：DTO（Data Transfer Object，数据传输对象）是经运行时校验的输入结构；ViewModel 是给调用方
 * 的脱敏响应结构，不能直接复用数据库行。fail-closed 指缺少授权、所有权或配置证据时记录 blocked，
 * 而不是尝试调用其他用户或默认模型。
 */
import type { z } from "zod";

/** 服务端固定映射的模型职责；调用方不能借此传入任意角色或 Provider 能力。 */
export type ModelRole = "orchestrator" | "engineer" | "artist";

/** ModelCall 审计记录的有限状态机；`running` 之外的状态均不表示候选补丁已验证或部署。 */
export type ModelCallStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "abandoned";

/**
 * 结构化模型调用的服务内输入。
 * 由固定业务流程构造，OpenAiService 在模型出站前结合 Run 所有权和用户配置进行授权；不是 HTTP DTO，
 * 也不携带 API Key、Worker token、lease 或任意 Provider 参数。
 *
 * @typeParam T 由调用方提供的已定义 Zod 输出类型；TypeScript 类型本身不代替 Provider 响应的运行时解析。
 */
export interface StructuredModelRequest<T> {
  /** 已存在 Run 的标识，来自上游领域 Service；用于读取不可变的出站授权和稳定 owner。 */
  runId: string;
  /** 固定非图片角色；禁止调用方以字符串选择未登记的模型用途。 */
  role: Exclude<ModelRole, "artist">;
  /** 审计请求格式的稳定名称，来自服务端代码，而非浏览器或 Worker 输入。 */
  schemaName: string;
  /** Provider 返回后必须执行的 Zod 输出校验；校验成功不证明模型内容适合补丁或客户端兼容。 */
  schema: z.ZodType<T>;
  /** 固定角色指令，由服务端领域流程提供；不得包含或回显用户模型密钥。 */
  instructions: string;
  /** 已受上游业务边界约束的文本输入；哈希会进入审计，但原文不应写入 ModelCall 记录。 */
  input: string;
}

/**
 * 图片模型调用的服务内输入。
 * 由受控生成流程提供，OpenAiService 仍会检查 Run 授权和配置所有权；不是允许指定尺寸、工具、存储或
 * 任意 endpoint 的通用图像 API。
 */
export interface ImageModelRequest {
  /** 已存在 Run 的标识，来自服务端业务流程，而非 Worker claim 或 lease。 */
  runId: string;
  /** 图片角色固定为 artist，避免文本流程越权切换为图像 Provider 请求。 */
  role: "artist";
  /** 服务端构建的受限提示词；调用完成后只保留哈希审计，不持久化图片 BLOB。 */
  prompt: string;
}

/**
 * 对调用方公开的脱敏模型调用审计视图。
 * 由 OpenAiService 创建并由 OpenAiRepository 持久化；仅描述一次调用的授权、出站和终态事实，
 * 不包含用户凭据、原始 Prompt/响应、图片字节、Worker token 或 lease。
 */
export interface ModelCallView {
  /** 服务端生成的 ModelCall 标识，不是 Provider 或 Run 的替代标识。 */
  id: string;
  /** 该审计事实绑定的 Run；不能据此证明 Run 已通过或部署。 */
  runId: string;
  /** 服务端固定角色，用于审计实际使用的配置映射。 */
  role: ModelRole;
  /** 已解析用户配置中的模型 ID；不代表外部端点已支持该模型。 */
  model: string;
  /** 已校验 endpoint 的脱敏身份标识，不是完整 URL、密钥或网络可达性证明。 */
  endpointIdentity: string;
  /** 已解析用户模型配置的版本；缺失于 blocked 或未配置路径，不能回退到其他用户配置。 */
  modelConfigurationVersion?: number;
  /** 规范化请求的 SHA-256，用于审计比对，不能反推出原始指令或输入。 */
  requestSha256: string;
  /** 规范化响应或图片字节的 SHA-256；存在只证明已记录的输出摘要，不证明其质量或兼容性。 */
  responseSha256?: string;
  /** Provider 返回的响应标识；它不是用户凭据，也不代表 Provider 持久化或复现保证。 */
  responseId?: string;
  /** 当前调用状态；终态只能说明本服务的审计状态转换已完成。 */
  status: ModelCallStatus;
  /** Run 允许模型出站的事实；为 false 时不得产生网络请求。 */
  modelEgressAuthorized: boolean;
  /** 实际发起 Provider 请求前置为 true 的审计事实；false 不等同于 Provider 未收到任何历史请求。 */
  modelEgressPerformed: boolean;
  /** 稳定失败或阻断码；不携带 Provider 原始错误、堆栈或敏感配置细节。 */
  errorCode?: string;
  /** 服务端创建审计记录的 UTC 时间字符串，不是 Provider 接收时间。 */
  createdAtUtc: string;
  /** 服务端写入终态的 UTC 时间字符串；不存在时调用仍可能由恢复器处理。 */
  finishedAtUtc?: string;
}

/**
 * 结构化调用结果。
 * `value` 仅在 Provider 成功且 Zod 校验通过时存在；`record` 始终提供脱敏审计事实，不能证明模型
 * 输出已经写入数据库、生成 Job 或满足 Guardrail。
 *
 * @typeParam T 与请求 schema 对应的已解析值类型。
 */
export interface StructuredModelResult<T> {
  /** 通过调用方 Zod schema 的解析值；blocked 或 failed 时为 undefined。 */
  value?: T;
  /** 本次调用的脱敏审计视图，供上游根据稳定状态继续或停止业务流程。 */
  record: ModelCallView;
}

/**
 * 图片调用结果。
 * 图片字节仅短暂驻留在受控服务内存中，调用方必须另经 Artifact 流程处理；存在字节不证明对象存储
 * finalize、候选 NPK 兼容或部署已发生。
 */
export interface ImageModelResult {
  /** 成功返回的非空 PNG 字节；failed、blocked 时为 undefined，且不会写入数据库 BLOB。 */
  bytes?: Uint8Array;
  /** 本次调用的脱敏审计视图，记录授权、实际出站和稳定终态。 */
  record: ModelCallView;
}
