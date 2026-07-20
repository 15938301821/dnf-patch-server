/**
 * @fileoverview 在停机期间制造 stale ModelCall，并验证下次启动的恢复器将其收敛为 abandoned。
 * @module runtime-test
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 3 model recovery
 */
import { assert } from "./process.mjs";

const staleModelCallId = "runtime-stale-model-call";

/** 插入超过最大 provider 请求窗口的 running 记录。 */
export async function insertStaleModelCall(database, runId) {
  await database.query(
    "INSERT INTO model_calls (id, run_id, role, model, endpoint_identity, request_sha256, status, model_egress_authorized, model_egress_performed, created_at) VALUES (?, ?, 'engineer', 'runtime-model', 'runtime.invalid/v1', ?, 'running', true, true, CURRENT_TIMESTAMP(3) - INTERVAL 20 MINUTE)",
    [staleModelCallId, runId, "F".repeat(64)],
  );
  return staleModelCallId;
}

/** 验证启动恢复器写入稳定错误码和完成时间。 */
export async function verifyStaleModelCallRecovered(database, id) {
  const [rows] = await database.query(
    "SELECT status, model_egress_authorized AS modelEgressAuthorized, model_egress_performed AS modelEgressPerformed, error_code AS errorCode, finished_at AS finishedAt FROM model_calls WHERE id = ?",
    [id],
  );
  assert(
    rows.length === 1 &&
      rows[0].status === "abandoned" &&
      Boolean(rows[0].modelEgressAuthorized) &&
      Boolean(rows[0].modelEgressPerformed) &&
      rows[0].errorCode === "MODEL_CALL_ABANDONED_AFTER_RESTART" &&
      rows[0].finishedAt !== null,
    "Startup recovery did not abandon the stale ModelCall with factual egress state.",
  );
  return { staleRunningAbandonedAfterRestart: true };
}
