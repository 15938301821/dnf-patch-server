/**
 * @fileoverview 编排当前 Profession lease 的冻结技能源查询并映射稳定业务异常；不访问对象存储、
 * 不读取源帧、不调用模型或本机工具。
 * @module modules/job/profession-source-context-service
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：ProfessionSourceContextController 完成 Worker token 与 DTO 校验后调用本 Service；本层
 * 委托 Repository 在事务内验证 Job/lease/payload/来源证据。输入输出均为脱敏领域结构。
 * 副作用：只触发 Repository 的只读事务和 Job 行锁，不签发 URL、不写状态或调用外部系统。
 * 安全边界：所有非 accepted 状态都必须映射为有限错误，不能回显哪一行、路径或 provenance 失败。
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import type { ProfessionSkillSourceContextView } from "./profession-source-context.contracts.js";
import {
  ProfessionSourceContextRepository,
  type ResolveProfessionSkillSourceContextResult,
} from "./profession-source-context.repository.js";

interface ProfessionSourceContextRepositoryPort {
  resolveSkillSourceContext(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ResolveProfessionSkillSourceContextResult>;
}

@Injectable()
/** 冻结技能源业务层，将 Repository 有限状态转换为内部 HTTP 可用的稳定异常。 */
export class ProfessionSourceContextService {
  /** @param sources 拥有 Job 锁、数据库时间和多表证据校验的数据访问边界。 */
  constructor(
    @Inject(ProfessionSourceContextRepository)
    private readonly sources: ProfessionSourceContextRepositoryPort,
  ) {}

  /**
   * 读取当前 attempt 中一个技能的冻结 NPK/IMG 来源事实。
   * @param jobId 内部路由 path 已校验的 Job UUID。
   * @param input 当前 Worker claim 的完整 fencing DTO，不含路径或工具参数。
   * @returns Worker 可用于本机源 profile 交叉核对的脱敏 ViewModel；不证明帧已导出。
   * @throws JOB_LEASE_MISMATCH、PATCH_TASK_JOB_KIND_REQUIRED、PROFESSION_JOB_INTEGRITY_FAILED、
   * PROFESSION_JOB_SKILL_NOT_FOUND 或 PROFESSION_SOURCE_EVIDENCE_MISMATCH。
   */
  async getSkillSourceContext(
    jobId: string,
    input: RequestProfessionSkillExecutionInput,
  ): Promise<ProfessionSkillSourceContextView> {
    const result = await this.sources.resolveSkillSourceContext(jobId, input);
    if (result.status === "accepted") return result.context;
    const definition = sourceContextFailureDefinitions[result.status];
    if (definition.kind === "not-found") {
      throw new NotFoundException({
        code: definition.code,
        message: definition.message,
      });
    }
    throw new ConflictException({
      code: definition.code,
      message: definition.message,
    });
  }
}

const sourceContextFailureDefinitions: Record<
  Exclude<ResolveProfessionSkillSourceContextResult["status"], "accepted">,
  { kind: "conflict" | "not-found"; code: string; message: string }
> = {
  "lease-mismatch": {
    kind: "conflict",
    code: "JOB_LEASE_MISMATCH",
    message: "任务租约不存在、已过期或不属于当前 Worker。",
  },
  "job-kind-mismatch": {
    kind: "conflict",
    code: "PATCH_TASK_JOB_KIND_REQUIRED",
    message: "只有 profession 类型任务可以读取冻结技能源。",
  },
  "job-integrity-failed": {
    kind: "conflict",
    code: "PROFESSION_JOB_INTEGRITY_FAILED",
    message: "职业制作任务的冻结内容完整性校验失败。",
  },
  "skill-not-found": {
    kind: "not-found",
    code: "PROFESSION_JOB_SKILL_NOT_FOUND",
    message: "请求的技能不在职业制作任务的冻结技能集合中。",
  },
  "source-evidence-mismatch": {
    kind: "conflict",
    code: "PROFESSION_SOURCE_EVIDENCE_MISMATCH",
    message: "职业制作任务的冻结资源证据不完整或已漂移。",
  },
};
