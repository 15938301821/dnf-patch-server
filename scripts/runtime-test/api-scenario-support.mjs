/**
 * @fileoverview 为隔离 API 主场景提供 Run DTO 和受控 Job lease 状态辅助；不发 HTTP 或创建资源正文。
 * @module scripts/runtime-test/api-scenario-support
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 服务端隔离 MySQL runtime 门禁
 *
 * 调用关系：api-scenario 使用这些函数构造固定 Run 请求，并在临时 MySQL 中延迟、激活、过期和核验
 * 测试 Job。输入只来自该场景已创建的 ID，输出 DTO 或有限数据库状态。
 * 安全边界：固定 SQL 只作用于上层临时数据库；不接收 HTTP 内容、连接串、对象路径或生产标识。
 */
import { assert } from "./process.mjs";

/** 将唯一 queued Job 置为不可派发并返回其 ID。 */
export async function deferQueuedJob(database, runId) {
  const [result] = await database.query(
    "UPDATE jobs SET dispatch_ready_at = NULL WHERE run_id = ? AND status = 'queued'",
    [runId],
  );
  assert(result.affectedRows === 1, "Could not defer the queued test Job.");
  const [rows] = await database.query(
    "SELECT id FROM jobs WHERE run_id = ? AND dispatch_ready_at IS NULL",
    [runId],
  );
  assert(rows.length === 1, "Deferred test Job was not persisted.");
  return rows[0].id;
}

/** 激活场景已延迟的唯一 Job。 */
export async function activateDeferredJob(database, jobId) {
  const [result] = await database.query(
    "UPDATE jobs SET dispatch_ready_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND dispatch_ready_at IS NULL",
    [jobId],
  );
  assert(
    result.affectedRows === 1,
    "Could not activate the deferred test Job.",
  );
}

/** 构造四项安全状态固定 false 的版本化 Run DTO。 */
export function createRunBody(projectId, snapshotId, overrides = {}) {
  return {
    projectId,
    snapshotId,
    clientRunId: overrides.clientRunId ?? "runtime-run",
    action: "validate-only",
    requestSha256: overrides.requestSha256 ?? "5".repeat(64),
    serverConnectionEnabled: true,
    modelEgressAuthorized: false,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    jobs: [
      {
        kind: "context-freeze",
        payload: {
          schemaVersion: 1,
          profileId: "runtime-profile",
          parameters: {
            scope: overrides.scope ?? "runtime-integration",
          },
        },
        maxAttempts: 2,
      },
    ],
    policyId: "runtime-policy",
    policySha256: "6".repeat(64),
  };
}

/** 使用数据库时间让当前测试 lease 过期。 */
export async function expireLease(database, jobId) {
  const [result] = await database.query(
    "UPDATE jobs SET lease_expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ? AND status = 'leased'",
    [jobId],
  );
  assert(result.affectedRows === 1, "Could not expire the active test lease.");
}

/** 核验重领前 attempt 已 timed_out，当前 attempt 保持 running。 */
export async function assertReclaimedAttemptState(database, jobId) {
  const [attempts] = await database.query(
    "SELECT attempt, status, error_code AS errorCode FROM job_attempts WHERE job_id = ? ORDER BY attempt",
    [jobId],
  );
  assert(
    attempts.length === 2 &&
      attempts[0].status === "timed_out" &&
      attempts[0].errorCode === "LEASE_EXPIRED" &&
      attempts[1].status === "running",
    "Reclaim did not close the expired attempt before opening a new attempt.",
  );
}
