import { requestJson } from "./api-support.mjs";
import { assert } from "./process.mjs";

export async function exerciseJobIntegrityQuarantine({
  baseUrl,
  clientToken,
  workerToken,
  database,
  workerId,
  projectId,
  snapshotId,
  createRunBody,
}) {
  const run = await requestJson(
    baseUrl,
    "/runs",
    {
      method: "POST",
      clientToken,
      headers: { "Idempotency-Key": "runtime-integrity-idempotency" },
      body: createRunBody(projectId, snapshotId, {
        clientRunId: "runtime-integrity-run",
        requestSha256: "9".repeat(64),
        scope: "runtime-integrity",
      }),
    },
    201,
  );
  const jobId = await tamperQueuedJob(database, run.id);
  const failure = await requestJson(
    baseUrl,
    "/internal/jobs/claim",
    { method: "POST", workerToken, body: { workerId } },
    409,
  );
  assert(
    failure.code === "JOB_INTEGRITY_FAILED",
    "A tampered persisted Job did not return the stable integrity error.",
  );
  const laterClaim = await requestJson(
    baseUrl,
    "/internal/jobs/claim",
    { method: "POST", workerToken, body: { workerId } },
    201,
  );
  assert(
    laterClaim === undefined,
    "A quarantined Job was selected by a later claim.",
  );
  await assertIntegrityQuarantine(
    database,
    baseUrl,
    clientToken,
    run.id,
    jobId,
  );
  return { runId: run.id, jobId };
}

async function tamperQueuedJob(database, runId) {
  const [jobs] = await database.query(
    "SELECT id FROM jobs WHERE run_id = ? AND status = 'queued'",
    [runId],
  );
  assert(jobs.length === 1, "Integrity scenario did not find one queued Job.");
  const [result] = await database.query(
    "UPDATE jobs SET payload_sha256 = ? WHERE id = ?",
    ["F".repeat(64), jobs[0].id],
  );
  assert(result.affectedRows === 1, "Could not tamper the queued Job hash.");
  return jobs[0].id;
}

async function assertIntegrityQuarantine(
  database,
  baseUrl,
  clientToken,
  runId,
  jobId,
) {
  const [jobs] = await database.query(
    "SELECT status, lease_owner_id AS leaseOwnerId, lease_id AS leaseId, lease_expires_at AS leaseExpiresAt FROM jobs WHERE id = ?",
    [jobId],
  );
  assert(
    jobs.length === 1 &&
      jobs[0].status === "blocked" &&
      jobs[0].leaseOwnerId === null &&
      jobs[0].leaseId === null &&
      jobs[0].leaseExpiresAt === null,
    "Integrity failure did not quarantine the Job and clear its lease.",
  );
  const run = await requestJson(
    baseUrl,
    `/runs/${runId}`,
    { clientToken },
    200,
  );
  const events = await requestJson(
    baseUrl,
    `/runs/${runId}/events?afterSequence=-1&limit=10`,
    { clientToken },
    200,
  );
  assert(
    run.status === "blocked" &&
      events.length === 3 &&
      events[1].stage === "integrity" &&
      events[2].stage === "blocked",
    "Integrity failure did not append the quarantine and terminal events.",
  );
}
