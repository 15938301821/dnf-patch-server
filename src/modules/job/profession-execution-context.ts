/**
 * @fileoverview 从已锁定的当前 Profession Job 中解析单技能冻结上下文；不查询数据库、不调用模型、
 * 不访问对象存储，也不把冻结 Prompt 暴露给 Worker。
 * @module modules/job/profession-execution-context
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：后续 Profession 执行 Repository 在 transaction 中锁定 Job 并读取数据库时间后调用本函数；
 * Service 只在返回 accepted 时使用内部冻结上下文构造固定模型请求。输入是数据库 Job 快照、已校验租约
 * DTO 与数据库时间；输出是有限拒绝状态或服务内上下文。副作用：纯内存解析与哈希计算。
 * 安全边界：必须同时验证 owner、leaseId、attempt、期限、Job kind、payload schema、payload SHA-256
 * 和 skill 归属；任一缺失都 fail-closed，且返回给 HTTP 的响应不得直接复用 accepted 上下文。
 */
import { sha256Json } from "../../common/utils/canonical.js";
import type { JobLeaseState } from "./job-lease.js";
import type { RequestProfessionSkillExecutionInput } from "./profession-execution.contracts.js";
import {
  styleSkillProductionJobPayloadV2Schema,
  type StyleSkillPromptPackageV2,
} from "./style-skill-production.contracts.js";

/** 解析前由 Repository 从锁定 jobs 行提供的最小持久化快照。 */
export interface ProfessionExecutionJobState extends JobLeaseState {
  /** Job 所属 Run，后续模型审计和 Artifact 必须继续绑定该值。 */
  runId: string;
  /** 只有 profession kind 可以进入本生产上下文。 */
  kind: string;
  /** 数据库冻结的声明式 JSON，仍需重新执行运行时 schema 校验。 */
  payload: unknown;
  /** Job 创建时保存的规范化 payload SHA-256，用于发现领取后的持久化漂移。 */
  payloadSha256: string;
}

/** 仅在服务进程内流转的单技能冻结上下文，不可作为 Worker HTTP ViewModel。 */
export interface FrozenProfessionSkillExecutionContext {
  runId: string;
  profileId: string;
  professionId: string;
  styleId: string;
  themeDefinition: StyleSkillPromptPackageV2["themeDefinition"];
  skill: StyleSkillPromptPackageV2["skills"][number];
}

/** 不产生模型或对象存储副作用的有限解析结果。 */
export type ResolveProfessionExecutionContextResult =
  | {
      status: "accepted";
      context: FrozenProfessionSkillExecutionContext;
    }
  | {
      status:
        | "lease-mismatch"
        | "job-kind-mismatch"
        | "job-integrity-failed"
        | "skill-not-found";
    };

/**
 * 解析当前 lease 唯一允许执行的冻结技能上下文。
 *
 * @param job Repository 在同一 transaction 中以 `FOR UPDATE` 锁定的 Job 快照。
 * @param input Worker token 认证之后、经严格 DTO schema 校验的当前 fencing 身份和技能 ID。
 * @param now 同一 transaction 从数据库取得的权威时间，不能使用 Worker 或应用本机时间代替。
 * @returns accepted 时只供服务内模型编排使用；拒绝状态不得触发模型、上传授权或生产状态写入。
 */
export function resolveProfessionExecutionContext(
  job: ProfessionExecutionJobState,
  input: RequestProfessionSkillExecutionInput,
  now: Date,
): ResolveProfessionExecutionContextResult {
  // 第一步：新协议要求 owner、fencing token、attempt 与数据库期限全部精确匹配，不沿用旧版省略 token 兼容。
  if (
    job.status !== "leased" ||
    job.leaseOwnerId !== input.workerId ||
    job.leaseId !== input.leaseId ||
    job.attemptCount !== input.attempt ||
    !job.leaseExpiresAt ||
    job.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    return { status: "lease-mismatch" };
  }
  if (job.kind !== "profession") {
    return { status: "job-kind-mismatch" };
  }

  // 第二步：重新解析冻结 V2 payload 并核对外层哈希，防止领取后的数据库漂移进入模型出站。
  const payload = styleSkillProductionJobPayloadV2Schema.safeParse(job.payload);
  if (
    !payload.success ||
    sha256Json(payload.data) !== job.payloadSha256.toUpperCase()
  ) {
    return { status: "job-integrity-failed" };
  }

  // 第三步：技能只能从已通过 V2 schema 的冻结有序集合中选择，未知 ID 不能变成任意 Prompt 入口。
  const skill = payload.data.parameters.promptPackage.skills.find(
    (candidate) => candidate.skillId === input.skillId,
  );
  if (!skill) return { status: "skill-not-found" };
  return {
    status: "accepted",
    context: {
      runId: job.runId,
      profileId: payload.data.profileId,
      professionId: payload.data.parameters.professionId,
      styleId: payload.data.parameters.styleId,
      themeDefinition: payload.data.parameters.promptPackage.themeDefinition,
      skill,
    },
  };
}
