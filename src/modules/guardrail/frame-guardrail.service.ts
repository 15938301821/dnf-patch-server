/**
 * @fileoverview 将候选帧证据与 Run 所属 Factory v2 冻结策略和来源帧不变量进行比对，并持久化审计决策；
 * 不读取图片/NPK 字节、不调用模型、不创建 Worker Job或部署补丁。
 * @module modules/guardrail/frame-service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：GuardrailController 解析 HTTP DTO 后调用 evaluate；本类通过 DatabaseService 查询 Run、
 * Project 与 Factory，随后向 guardrailDecisions 写入单条可审计结果。
 * 输入输出：输入是严格的来源/候选帧证据和策略标识；输出是 FrameGuardrailResult，不返回 Factory JSON、
 * 图片字节或原始数据库行。
 * 副作用：读取 Run 绑定并插入 Guardrail 决策。当前写入不创建 Run/Job，也不替代 Run 创建事务中的
 * 声明式 payload Guardrail。
 * 安全边界：策略必须从该 Run 的 Factory v2 冻结配置解析；来源哈希、尺寸、锚点或可见 alpha 不一致时
 * fail-closed。allow 不是资源映射、客户端兼容或部署证明。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  factories,
  guardrailDecisions,
  projects,
  runs,
} from "../../common/db/schema.js";
import { sha256Json } from "../../common/utils/canonical.js";
import { factoryConfigSchema } from "../factory/factory.contracts.js";
import type {
  FrameGuardrailInput,
  FrameGuardrailResult,
} from "./frame-guardrail.contracts.js";

@Injectable()
/** 负责帧证据审计的领域 Service，向 Controller 隐藏 Drizzle 查询和持久化细节。 */
export class FrameGuardrailService {
  /** @param connection 受应用生命周期管理的数据库访问边界，用于读取冻结策略和保存决策。 */
  constructor(private readonly connection: DatabaseService) {}

  /**
   * 评估并记录候选帧是否保持来源不变量。
   *
   * 步骤 1：沿 Run -> Project -> Factory 查询当前 Run 的冻结配置；步骤 2：验证调用方 policyId/
   * policySha256 与 Factory v2 完全一致；步骤 3：逐项比较来源身份、尺寸/画布、锚点和 alpha；
   * 步骤 4：无论 allow/deny 都写入带输入摘要的审计决策。Run/策略缺失或不匹配时在写入前抛出，
   * 防止调用方把候选帧绑定到任意策略。
   *
   * @param input Controller 已按严格 schema 校验的帧证据与策略声明。
   * @returns 已持久化的 FrameGuardrailResult；deny 结果是可审计业务判断，不是异常成功。
   * @throws GUARDRAIL_RUN_NOT_FOUND、GUARDRAIL_POLICY_UNAVAILABLE 或 GUARDRAIL_POLICY_MISMATCH
   * 当缺少 Run 或冻结策略证据时抛出，且不会插入决策记录。
   */
  async evaluate(input: FrameGuardrailInput): Promise<FrameGuardrailResult> {
    // 步骤 1：只从该 Run 的 Project/Factory 链读取冻结策略，不能信任请求自行选择的 policy。
    const [binding] = await this.connection.database
      .select({ factoryConfig: factories.config })
      .from(runs)
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .innerJoin(factories, eq(factories.id, projects.factoryId))
      .where(eq(runs.id, input.runId))
      .limit(1);
    if (!binding) {
      throw new NotFoundException({
        code: "GUARDRAIL_RUN_NOT_FOUND",
        message: "Frame Guardrail 绑定的 Run 不存在。",
      });
    }
    // 步骤 2：Factory v1 或不同策略摘要都没有足够证据继续比较候选帧，必须 fail-closed。
    const policyStatus = validateFramePolicyBinding(
      input,
      binding.factoryConfig,
    );
    if (policyStatus === "unavailable") {
      throw new ConflictException({
        code: "GUARDRAIL_POLICY_UNAVAILABLE",
        message: "Run 的冻结策略不可用于 Frame Guardrail。",
      });
    }
    if (policyStatus === "mismatch") {
      throw new ConflictException({
        code: "GUARDRAIL_POLICY_MISMATCH",
        message: "Frame Guardrail 策略与 Run 的冻结策略不一致。",
      });
    }
    // 步骤 3：比较可验证元数据而非资源名称；每个 false 都形成稳定 deny reasonCode。
    const checks = {
      sourceHash:
        input.candidate.sourceSha256.toUpperCase() ===
        input.source.sha256.toUpperCase(),
      size:
        input.candidate.geometry.width === input.source.geometry.width &&
        input.candidate.geometry.height === input.source.geometry.height &&
        input.candidate.geometry.canvasWidth ===
          input.source.geometry.canvasWidth &&
        input.candidate.geometry.canvasHeight ===
          input.source.geometry.canvasHeight,
      anchor:
        input.candidate.geometry.x === input.source.geometry.x &&
        input.candidate.geometry.y === input.source.geometry.y,
      alpha:
        input.source.alphaNonZeroPixels === 0 ||
        input.candidate.alphaNonZeroPixels > 0,
    };
    const failed = Object.entries(checks).find(([, passed]) => !passed)?.[0];
    const decision = failed ? "deny" : "allow";
    const reasonCode = failed
      ? `FRAME_${failed.toUpperCase()}_MISMATCH`
      : "FRAME_INVARIANTS_PASSED";
    const id = randomUUID();
    const createdAt = new Date();
    // 步骤 4：allow 与 deny 都写入审计记录，供后续 Run/审核链路复核，而不是只保留成功样本。
    await this.connection.database.insert(guardrailDecisions).values({
      id,
      runId: input.runId,
      policyId: input.policyId,
      policySha256: input.policySha256.toUpperCase(),
      inputSha256: sha256Json(input),
      decision,
      reasonCode,
      details: checks,
      createdAt,
    });
    return {
      id,
      runId: input.runId,
      decision,
      reasonCode,
      checks,
      createdAtUtc: createdAt.toISOString(),
    };
  }
}

/** Factory 冻结策略与请求 policy 的绑定结果；unavailable 与 mismatch 都不能继续评估帧。 */
export type FramePolicyBindingStatus = "matched" | "mismatch" | "unavailable";

/**
 * 只接受 Run 所属的 Factory v2 冻结策略，避免调用方伪造 Frame Guardrail 的策略来源。
 * @param input 请求中声明的 policyId 与 policySha256，不信任其本身，需要与数据库 JSON 比对。
 * @param factoryConfig 从 Run 所属 Factory 读取的未知 JSON，必须先通过 factoryConfigSchema 解析。
 * @returns matched 表示 v2 配置与请求完全对应；unavailable/mismatch 都要求上游拒绝而非降级。
 */
export function validateFramePolicyBinding(
  input: Pick<FrameGuardrailInput, "policyId" | "policySha256">,
  factoryConfig: unknown,
): FramePolicyBindingStatus {
  const parsed = factoryConfigSchema.safeParse(factoryConfig);
  if (!parsed.success || parsed.data.schemaVersion !== 2) {
    return "unavailable";
  }
  return parsed.data.policyId === input.policyId &&
    parsed.data.policySha256.toUpperCase() === input.policySha256.toUpperCase()
    ? "matched"
    : "mismatch";
}
