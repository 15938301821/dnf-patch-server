/**
 * @fileoverview 验证 Run outbox 在停机期间保留 pending，并由重启后的单进程 dispatcher 重放。
 * @module runtime-test
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 transactional outbox
 */
import { assert, delay } from "./process.mjs";

export async function waitForRunOutboxDrained(database) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [rows] = await database.query(
      "SELECT COUNT(*) AS count FROM outbox_events WHERE topic = 'run.event' AND published_at IS NULL",
    );
    if (Number(rows[0].count) === 0) return;
    await delay(100);
  }
  throw new Error("Run outbox did not drain before the restart scenario.");
}

export async function restorePublishedRunEventToPending(database, runId) {
  const [rows] = await database.query(
    "SELECT id FROM outbox_events WHERE topic = 'run.event' AND aggregate_id = ? AND published_at IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
    [runId],
  );
  assert(rows.length === 1, "No published Run event was available to replay.");
  const [result] = await database.query(
    "UPDATE outbox_events SET published_at = NULL WHERE id = ? AND topic = 'run.event' AND published_at IS NOT NULL",
    [rows[0].id],
  );
  assert(
    result.affectedRows === 1,
    "Could not restore a published Run event to pending.",
  );
  const [pendingRows] = await database.query(
    "SELECT COUNT(*) AS count FROM outbox_events WHERE id = ? AND published_at IS NULL",
    [rows[0].id],
  );
  assert(
    Number(pendingRows[0].count) === 1,
    "Pending Run event was not retained while the service was stopped.",
  );
  return rows[0].id;
}

export async function waitForRunOutboxReplay(database, outboxId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [rows] = await database.query(
      "SELECT published_at AS publishedAt FROM outbox_events WHERE id = ? AND topic = 'run.event'",
      [outboxId],
    );
    if (rows.length === 1 && rows[0].publishedAt !== null) {
      return {
        pendingRetainedBeforeRestart: true,
        replayedAfterRestart: true,
        deliverySemantics: "at-least-once",
      };
    }
    await delay(100);
  }
  throw new Error(
    "Restarted dispatcher did not publish the pending Run event.",
  );
}
