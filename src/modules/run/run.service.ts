/**
 * @fileoverview 编排 Run 的安全创建、幂等重放、Factory v2/Project/Snapshot/Job contract/Guardrail 校验、
 * 事件读取与延迟派发补偿；不处理 HTTP 协议、直接 Drizzle 操作、Worker lease 或 Socket 广播。
 * @module modules/run/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：RunController、职业生产计划和 OpenAI 模块调用本类；本类调用 ProjectService、FactoryService、
 * GuardrailService 和 RunRepository。Repository 事务提交后由 outbox dispatcher 而非本类直接广播事件。
 * 输入输出：输入是已解析 Run DTO、Idempotency-Key 和仅内部可用选项；输出是 Run/Event/Model Context
 * ViewModel 或稳定 HTTP 领域错误，不返回数据库行、模型凭据、Worker token、本机路径或命令。
 * 副作用：create 经 Repository 原子写入 Run/决策/可选 Job/事件/outbox；get/events 只读；
 * blockDeferredDispatch 只在严格条件下执行补偿状态写入。
 * 安全边界：幂等重放绑定完整请求和 owner；Project/Snapshot/Factory v2/策略/Job contract 任一缺失或不一致
 * 必须失败；Guardrail deny 创建 blocked Run 但零 Job；部署、全技能覆盖与兼容证明始终不可提升。该 Service
 * 不证明 Worker capability、Artifact 完整性、模型调用结果或真实客户端兼容性。
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isMysqlDuplicateEntry } from "../../common/db/mysql-errors.js";
import { FactoryService } from "../factory/factory.service.js";
import { GuardrailService } from "../guardrail/guardrail.service.js";
import { parseJobPayload } from "../job/job-payload-contracts.js";
import { hasSharedFxPayloadBinding } from "../job/shared-fx.contracts.js";
import { ProjectService } from "../project/project.service.js";
import type {
  CreateRunInput,
  RunCreateOptions,
  RunEventQuery,
  RunEventView,
  RunModelContext,
  RunView,
} from "./run.contracts.js";
import { createRunRequestFingerprint } from "./run-fingerprint.js";
import { RunRepository, type RunIdempotencyRecord } from "./run.repository.js";

@Injectable()
/** Run 领域业务编排层，向 HTTP 与其他模块隐藏跨领域验证和事务 Repository 细节。 */
export class RunService {
  /**
   * @param runs Run 的事务/查询持久化边界。
   * @param guardrail 声明式 Job 安全决策 Service，返回 allow/deny 但不写数据库。
   * @param projects Project/Snapshot 公开 Service，负责存在性和归属查询。
   * @param factories Factory 公开 Service，提供冻结 v2 策略与 job contracts。
   */
  constructor(
    private readonly runs: RunRepository,
    private readonly guardrail: GuardrailService,
    private readonly projects: ProjectService,
    private readonly factories: FactoryService,
  ) {}

  /**
   * 读取 Run 的公开状态。
   * @param id 已校验的服务器 Run id。
   * @returns RunView。
   * @throws RUN_NOT_FOUND 当持久化记录不存在时抛出。
   */
  async get(id: string): Promise<RunView> {
    const run = await this.runs.findById(id);
    if (!run) {
      throw new NotFoundException({
        code: "RUN_NOT_FOUND",
        message: "Run 不存在。",
      });
    }
    return run;
  }

  /**
   * 获取固定角色模型调用所需的受限 Run 上下文。
   * @param id Run id。
   * @returns model egress 开关与可选稳定 ownerUserId，不包含任何模型凭据。
   * @throws RUN_NOT_FOUND 当 Run 不存在时抛出。
   */
  async getModelContext(id: string): Promise<RunModelContext> {
    const context = await this.runs.findModelContext(id);
    if (!context) {
      throw new NotFoundException({
        code: "RUN_NOT_FOUND",
        message: "Run 不存在。",
      });
    }
    return context;
  }

  /**
   * 验证冻结上下文后创建或安全重放 Run。
   *
   * 步骤 1：计算覆盖完整 DTO 和 owner 的服务器幂等指纹，并优先检查同 Project 的已有 key；步骤 2：读取
   * Project/Snapshot/Factory，拒绝 archived、disabled 或非 v2 Factory；步骤 3：确认 input policy 与 Factory
   * 冻结 policyId/hash 一致；步骤 4：逐 Job 检查允许 kind、版本化 payload schema、profile 和 shared-fx
   * Snapshot 绑定；步骤 5：为每个 Job 计算 Guardrail 决策；步骤 6：在 Repository 事务内写入权威状态。
   * MySQL 唯一键竞争时重新读取幂等记录，只接受相同服务器指纹，避免并发请求创建两个语义不同的 Run。
   *
   * @param input Controller 或受控内部调用已严格解析的 Run DTO。
   * @param idempotencyKey 同 Project 范围内已通过格式校验的请求键。
   * @param options 仅内部创建路径可设置的延迟派发和稳定 owner 选项，不能从普通 DTO 注入。
   * @returns 新建/重放的 RunView；blocked Run 仍是已审计结果，但没有任何新 Job。
   * @throws 领域冲突或 JOB_PAYLOAD_CONTRACT_FAILED，当冻结上下文、Payload、Guardrail 或幂等语义不成立时抛出。
   */
  async create(
    input: CreateRunInput,
    idempotencyKey: string,
    options: RunCreateOptions = {},
  ): Promise<RunView> {
    const requestFingerprintSha256 = createRunRequestFingerprint(
      input,
      options.ownerUserId,
    );
    const existing = await this.runs.findByIdempotency(
      input.projectId,
      idempotencyKey,
    );
    if (existing) {
      return this.resolveReplay(existing, requestFingerprintSha256);
    }
    const project = await this.projects.get(input.projectId);
    if (project.archived) {
      throw new ConflictException({
        code: "PROJECT_ARCHIVED",
        message: "已归档项目不能创建 Run。",
      });
    }
    const snapshot = await this.projects.getSnapshot(
      input.projectId,
      input.snapshotId,
    );
    const factory = await this.factories.get(project.factoryId);
    if (!factory.enabled) {
      throw new ConflictException({
        code: "FACTORY_DISABLED",
        message: "工厂模板已禁用。",
      });
    }
    if (factory.config.schemaVersion !== 2) {
      throw new ConflictException({
        code: "FACTORY_POLICY_VERSION_REQUIRED",
        message: "创建 Run 需要绑定策略哈希的 Factory v2 配置。",
      });
    }
    if (
      factory.config.policyId !== input.policyId ||
      factory.config.policySha256.toUpperCase() !==
        input.policySha256.toUpperCase()
    ) {
      throw new ConflictException({
        code: "RUN_POLICY_MISMATCH",
        message: "Run 策略与工厂冻结策略不一致。",
      });
    }
    const contracts = new Map(
      factory.config.jobContracts.map((contract) => [contract.kind, contract]),
    );
    for (const job of input.jobs) {
      const contract = contracts.get(job.kind);
      if (!factory.config.allowedJobKinds.includes(job.kind) || !contract) {
        throw new ConflictException({
          code: "JOB_KIND_NOT_ALLOWED",
          message: "工厂模板未允许提交的任务类型。",
        });
      }
      try {
        const payload = parseJobPayload(
          job.kind,
          contract.schemaVersion,
          job.payload,
        );
        if (payload.profileId !== factory.config.profileId) {
          throw new Error("JOB_PROFILE_MISMATCH");
        }
        if (
          job.kind === "shared-fx" &&
          !hasSharedFxPayloadBinding(payload, {
            profileId: factory.config.profileId,
            policyId: factory.config.policyId,
            policySha256: factory.config.policySha256,
            snapshot,
          })
        ) {
          throw new Error("SHARED_FX_PAYLOAD_BINDING_FAILED");
        }
      } catch {
        throw new BadRequestException({
          code: "JOB_PAYLOAD_CONTRACT_FAILED",
          message: "任务参数不符合已注册的声明式契约。",
        });
      }
    }
    const decisions = input.jobs.map((job) =>
      this.guardrail.evaluate({
        policyId: input.policyId,
        policySha256: input.policySha256,
        jobKind: job.kind,
        payload: job.payload,
        deploymentAuthorized: false,
      }),
    );
    try {
      return (
        await this.runs.create(
          input,
          idempotencyKey,
          requestFingerprintSha256,
          randomUUID(),
          decisions,
          options,
        )
      ).run;
    } catch (error) {
      if (!isMysqlDuplicateEntry(error)) throw error;
      const replay = await this.runs.findByIdempotency(
        input.projectId,
        idempotencyKey,
      );
      if (replay) return this.resolveReplay(replay, requestFingerprintSha256);
      if (
        await this.runs.findByClientRunId(input.projectId, input.clientRunId)
      ) {
        throw new ConflictException({
          code: "CLIENT_RUN_ID_CONFLICT",
          message: "clientRunId 已被当前项目中的其他 Run 使用。",
        });
      }
      throw error;
    }
  }

  /**
   * 验证 Run 存在后读取其权威事件页。
   * @param id Run id。
   * @param query 已受 schema 限制的 sequence 恢复条件。
   * @returns 有界、按 sequence 递增的事件数组；Socket 通知缺失时客户端应使用本方法恢复。
   * @throws RUN_NOT_FOUND 当 Run 不存在时抛出。
   */
  async events(id: string, query: RunEventQuery): Promise<RunEventView[]> {
    await this.get(id);
    return this.runs.events(id, query);
  }

  /**
   * 在后续计划事务失败时补偿尚未开放领取的延迟派发 Run。
   * @param runId 需要安全阻断的 Run。
   * @returns 无返回值；Repository 明确确认补偿成功或已 blocked 后才返回。
   * @throws DEFERRED_JOB_COMPENSATION_CONFLICT 当任何 Job 已可派发/领取或 Run 状态不适合补偿时抛出，
   * 以防把实际执行中的任务错误改为 blocked。
   */
  async blockDeferredDispatch(runId: string): Promise<void> {
    if (!(await this.runs.blockDeferredDispatch(runId))) {
      throw new Error("DEFERRED_JOB_COMPENSATION_CONFLICT");
    }
  }

  /**
   * 将已存在的幂等记录限制为同一服务器请求指纹的安全重放。
   * @param existing Repository 从同 Project+key 查到的 Run 与可选历史指纹。
   * @param requestFingerprintSha256 当前完整请求与 owner 的服务器指纹。
   * @returns 原有 RunView，仅在两份指纹完全相同的情况下。
   * @throws IDEMPOTENCY_RECORD_LEGACY 当旧记录缺少安全指纹，或 IDEMPOTENCY_KEY_REUSED 当语义不同。
   */
  private resolveReplay(
    existing: RunIdempotencyRecord,
    requestFingerprintSha256: string,
  ): RunView {
    if (!existing.requestFingerprintSha256) {
      throw new ConflictException({
        code: "IDEMPOTENCY_RECORD_LEGACY",
        message: "历史 Run 缺少服务器请求指纹，不能安全重放。",
      });
    }
    if (existing.requestFingerprintSha256 !== requestFingerprintSha256) {
      throw new ConflictException({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Idempotency-Key 已用于不同请求。",
      });
    }
    return existing.run;
  }
}
