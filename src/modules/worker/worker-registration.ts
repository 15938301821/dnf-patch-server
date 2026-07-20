/**
 * @fileoverview 判定 Worker 重复注册是否保持禁用状态与能力白名单，不执行数据库 I/O。
 * @module worker
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan JOB-001-SHARED-FX
 */
import type { AllowedJobKind } from "../guardrail/guardrail.contracts.js";

export interface ExistingWorkerRegistration {
  displayName: string;
  capabilities: AllowedJobKind[];
  disabled: boolean;
}

export type WorkerReregistrationStatus =
  | "accepted"
  | "disabled"
  | "identity-conflict";

/** 重复注册只能刷新完全一致且仍启用的 Worker，不能恢复禁用或改写能力。 */
export function validateWorkerReregistration(
  existing: ExistingWorkerRegistration,
  displayName: string,
  capabilities: readonly AllowedJobKind[],
): WorkerReregistrationStatus {
  if (existing.disabled) return "disabled";
  const previous = [...existing.capabilities].sort();
  const requested = [...capabilities].sort();
  return existing.displayName === displayName &&
    JSON.stringify(previous) === JSON.stringify(requested)
    ? "accepted"
    : "identity-conflict";
}
