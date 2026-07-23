/**
 * @fileoverview 定义候选帧与来源帧的不变量 Guardrail 输入和结果契约；不读取图片字节、不解析 NPK/IMG，
 * 也不按文件名推断帧映射。
 * @module modules/guardrail/frame-contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：GuardrailController 用 frameGuardrailSchema 解析 HTTP body；FrameGuardrailService 使用
 * 推导类型读取 Run 冻结策略、比较证据并保存 Guardrail 决策。
 * 输入输出：输入是来源/候选 SHA-256、画布几何、锚点和 alpha 计数；输出是有限 allow/deny ViewModel，
 * 不包含源帧、对象 URL、数据库行或模型输出。
 * 副作用：本文件只有内存 schema 校验；数据库查询和决策写入发生在 Service。
 * 安全边界：几何、来源哈希与 alpha 都来自可验证证据，不能用技能名、视觉描述或 Prompt 替代。
 */
import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

/**
 * 单帧及其画布/锚点的严格几何证据。
 * 宽高和画布不允许为负，x/y 可以为负以保留来源坐标语义；未知字段必须拒绝，避免隐藏偏移绕过比较。
 */
const frameGeometrySchema = z
  .object({
    width: z.number().int().min(0),
    height: z.number().int().min(0),
    canvasWidth: z.number().int().min(0),
    canvasHeight: z.number().int().min(0),
    x: z.number().int(),
    y: z.number().int(),
  })
  .strict();

/**
 * Frame Guardrail 的严格 HTTP DTO。
 * source.sha256 是来源证据身份，candidate.sourceSha256 必须由 Service 比对；policy 字段必须与 Run
 * 所属 Factory v2 的冻结策略一致，调用方不能自行选择任意策略。
 */
export const frameGuardrailSchema = z
  .object({
    runId: z.uuid(),
    policyId: z.string().min(1).max(100),
    policySha256: sha256Schema,
    source: z
      .object({
        sha256: sha256Schema,
        geometry: frameGeometrySchema,
        alphaNonZeroPixels: z.number().int().min(0),
      })
      .strict(),
    candidate: z
      .object({
        sourceSha256: sha256Schema,
        geometry: frameGeometrySchema,
        alphaNonZeroPixels: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

/** 经 frameGuardrailSchema 校验的来源/候选帧证据输入，不包含实际像素字节。 */
export type FrameGuardrailInput = z.infer<typeof frameGuardrailSchema>;

/**
 * 已持久化的帧不变量判断 ViewModel。
 * allow 只证明当前四项可验证不变量通过，不证明完整包、客户端兼容性或部署授权。
 */
export interface FrameGuardrailResult {
  id: string;
  runId: string;
  decision: "allow" | "deny";
  reasonCode: string;
  checks: {
    sourceHash: boolean;
    size: boolean;
    anchor: boolean;
    alpha: boolean;
  };
  createdAtUtc: string;
}
