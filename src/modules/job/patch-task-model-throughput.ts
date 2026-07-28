/**
 * @fileoverview 将同一制作 Run 的模型调用审计投影聚合为浏览器吞吐 ViewModel；不访问数据库、
 * 模型 Provider、对象存储或 Worker，也不读取请求/响应正文和模型凭据。
 * @module modules/job/patch-task-model-throughput
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 调用关系：详情 Repository 读取同 Run 的有限 ModelCall 投影，patch-task-detail 调用本模块生成
 * 汇总、角色/模型分组和最近 60 条趋势样本。输入输出均为脱敏结构，副作用为无。安全边界：
 * 只有实际出站、Token usage 完整且 Provider 耗时为正的调用进入 Token/s 计算；缺失计量必须
 * 保持 NULL，不能用零值替代。Token/s 为总输出 Token 除以对应 Provider 总耗时，不是墙钟吞吐。
 */
import type {
  PatchTaskModelCallSampleView,
  PatchTaskModelCallStatus,
  PatchTaskModelGroupView,
  PatchTaskModelRole,
  PatchTaskModelThroughputView,
} from "./patch-task.contracts.js";

/** 一次模型调用的脱敏审计投影；Token 三项由数据库 CHECK 保证成组存在。 */
export interface PatchTaskDetailModelCallRecord {
  id: string;
  role: string;
  model: string;
  status: string;
  modelEgressPerformed: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  providerLatencyMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

/**
 * 聚合真实出站模型调用；只有 usage 完整且耗时为正的记录进入 Token 与吞吐计算。
 *
 * @param calls Repository 按同一 Run 读取的脱敏模型调用，不含 Provider 正文或凭据。
 * @returns 汇总计量、角色/模型分组及按时间升序保留的最近 60 条调用样本。
 */
export function aggregateModelThroughput(
  calls: PatchTaskDetailModelCallRecord[],
): PatchTaskModelThroughputView {
  const egressed = calls.filter((call) => call.modelEgressPerformed);
  const measured = egressed.filter(isMeasuredCall);
  const terminal = egressed.filter((call) => call.status !== "running");
  const passed = terminal.filter((call) => call.status === "passed").length;
  const groups = new Map<string, PatchTaskDetailModelCallRecord[]>();
  for (const call of calls) {
    const key = `${normalizeRole(call.role)}\u0000${call.model}`;
    groups.set(key, [...(groups.get(key) ?? []), call]);
  }
  return {
    totalCalls: calls.length,
    egressCalls: egressed.length,
    runningCalls: calls.filter((call) => call.status === "running").length,
    measuredCalls: measured.length,
    successRate:
      terminal.length > 0 ? round((passed / terminal.length) * 100) : null,
    ...tokenSummary(measured),
    averageProviderLatencyMs: averageLatency(egressed),
    groups: [...groups.values()]
      .map(groupView)
      .sort((left, right) => right.calls - left.calls),
    recentCalls: [...calls]
      .sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      )
      .slice(0, 60)
      .reverse()
      .map(sampleView),
  };
}

/** 将同一角色与模型的调用聚合为一行对比数据。 */
function groupView(
  calls: PatchTaskDetailModelCallRecord[],
): PatchTaskModelGroupView {
  const measured = calls.filter(
    (call) => call.modelEgressPerformed && isMeasuredCall(call),
  );
  return {
    role: normalizeRole(calls[0]?.role ?? "unknown"),
    model: calls[0]?.model ?? "unknown",
    calls: calls.length,
    measuredCalls: measured.length,
    ...tokenSummary(measured),
    averageProviderLatencyMs: averageLatency(
      calls.filter((call) => call.modelEgressPerformed),
    ),
  };
}

/** 对完整计量调用计算 Token 合计和按总 Provider 耗时加权的输出吞吐。 */
function tokenSummary(calls: PatchTaskDetailModelCallRecord[]): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  averageOutputTokensPerSecond: number | null;
} {
  if (calls.length === 0) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      averageOutputTokensPerSecond: null,
    };
  }
  const inputTokens = calls.reduce(
    (sum, call) => sum + (call.inputTokens ?? 0),
    0,
  );
  const outputTokens = calls.reduce(
    (sum, call) => sum + (call.outputTokens ?? 0),
    0,
  );
  const totalTokens = calls.reduce(
    (sum, call) => sum + (call.totalTokens ?? 0),
    0,
  );
  const latencyMs = calls.reduce(
    (sum, call) => sum + (call.providerLatencyMs ?? 0),
    0,
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    averageOutputTokensPerSecond: round((outputTokens * 1_000) / latencyMs),
  };
}

/** 把单次调用映射为趋势样本；未计量调用仍保留审计状态但所有 usage 字段为 NULL。 */
function sampleView(
  call: PatchTaskDetailModelCallRecord,
): PatchTaskModelCallSampleView {
  const measured = call.modelEgressPerformed && isMeasuredCall(call);
  return {
    id: call.id,
    role: normalizeRole(call.role),
    model: call.model,
    status: normalizeCallStatus(call.status),
    createdAt: call.createdAt.toISOString(),
    ...(call.finishedAt ? { finishedAt: call.finishedAt.toISOString() } : {}),
    inputTokens: measured ? call.inputTokens : null,
    outputTokens: measured ? call.outputTokens : null,
    totalTokens: measured ? call.totalTokens : null,
    providerLatencyMs: measured ? call.providerLatencyMs : null,
    outputTokensPerSecond: measured
      ? round(
          ((call.outputTokens ?? 0) * 1_000) / (call.providerLatencyMs ?? 1),
        )
      : null,
  };
}

/** 判断一条调用是否具备可参与吞吐计算的成组 Token 与正 Provider 耗时。 */
function isMeasuredCall(call: PatchTaskDetailModelCallRecord): boolean {
  return (
    call.inputTokens !== null &&
    call.outputTokens !== null &&
    call.totalTokens !== null &&
    call.providerLatencyMs !== null &&
    call.providerLatencyMs > 0
  );
}

/** 计算实际出站调用中已有 Provider 耗时的算术平均值。 */
function averageLatency(
  calls: PatchTaskDetailModelCallRecord[],
): number | null {
  const timed = calls.filter(
    (call) => call.providerLatencyMs !== null && call.providerLatencyMs > 0,
  );
  return timed.length === 0
    ? null
    : Math.round(
        timed.reduce((sum, call) => sum + (call.providerLatencyMs ?? 0), 0) /
          timed.length,
      );
}

/** 把异常历史角色保守归一为 unknown，避免向浏览器扩展未公开角色。 */
function normalizeRole(role: string): PatchTaskModelRole {
  return ["orchestrator", "engineer", "artist"].includes(role)
    ? (role as PatchTaskModelRole)
    : "unknown";
}

/** 把异常历史调用状态保守归一为 unknown，不能误显示为成功。 */
function normalizeCallStatus(status: string): PatchTaskModelCallStatus {
  return ["running", "passed", "failed", "blocked", "abandoned"].includes(
    status,
  )
    ? (status as PatchTaskModelCallStatus)
    : "unknown";
}

/** 统一保留一位小数，避免不同聚合层产生不一致显示值。 */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}
