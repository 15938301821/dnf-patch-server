import { randomUUID } from "node:crypto";
import {
  requestJson,
  sha256Json,
  socketEventMatching,
  subscribeRun,
} from "./api-support.mjs";
import { exerciseJobIntegrityQuarantine } from "./job-integrity-scenario.mjs";
import { exerciseEvidenceApi } from "./evidence-scenario.mjs";
import { assert } from "./process.mjs";

const host = "127.0.0.1";

export async function exerciseApi({
  apiPort,
  clientToken,
  workerToken,
  database,
}) {
  const baseUrl = `http://${host}:${String(apiPort)}/v1`;
  await requestJson(baseUrl, "/projects", {}, 401);
  await requestJson(
    baseUrl,
    "/internal/jobs/claim",
    { method: "POST", body: { workerId: randomUUID() } },
    401,
  );

  const policySha256 = "6".repeat(64);
  const config = {
    schemaVersion: 2,
    profileId: "runtime-profile",
    policyId: "runtime-policy",
    policySha256,
    allowedJobKinds: ["context-freeze"],
    jobContracts: [{ kind: "context-freeze", schemaVersion: 1 }],
    arbitraryExecution: false,
    deploymentAuthorized: false,
  };
  const factory = await requestJson(
    baseUrl,
    "/factories",
    {
      method: "POST",
      clientToken,
      body: {
        id: "runtime-factory-v2",
        version: "2.0.0",
        displayName: "Runtime Factory",
        config,
        configSha256: sha256Json(config),
      },
    },
    201,
  );
  const project = await requestJson(
    baseUrl,
    "/projects",
    {
      method: "POST",
      clientToken,
      body: {
        factoryId: factory.id,
        clientProjectId: "runtime-project",
        displayName: "Runtime Integration Project",
      },
    },
    201,
  );
  const snapshot = await requestJson(
    baseUrl,
    `/projects/${project.id}/snapshots`,
    {
      method: "POST",
      clientToken,
      body: {
        clientSnapshotId: "runtime-snapshot",
        rootRulesSha256: "1".repeat(64),
        manifestSha256: "2".repeat(64),
        promptTreeSha256: "3".repeat(64),
        toolCatalogSha256: "4".repeat(64),
        repositoryRevision: "runtime-integration",
        fullSkillCoverageProven: false,
      },
    },
    201,
  );
  const runBody = createRunBody(project.id, snapshot.id);
  const idempotencyHeaders = {
    "Idempotency-Key": "runtime-run-idempotency",
  };
  const [run, concurrentReplay] = await Promise.all([
    requestJson(
      baseUrl,
      "/runs",
      {
        method: "POST",
        clientToken,
        headers: idempotencyHeaders,
        body: runBody,
      },
      201,
    ),
    requestJson(
      baseUrl,
      "/runs",
      {
        method: "POST",
        clientToken,
        headers: idempotencyHeaders,
        body: runBody,
      },
      201,
    ),
  ]);
  assert(
    run.id === concurrentReplay.id,
    "Concurrent idempotent Run creation returned different Runs.",
  );
  const replay = await requestJson(
    baseUrl,
    "/runs",
    {
      method: "POST",
      clientToken,
      headers: idempotencyHeaders,
      body: runBody,
    },
    201,
  );
  assert(run.id === replay.id, "Idempotent Run creation returned a new Run.");
  const idempotencyConflict = await requestJson(
    baseUrl,
    "/runs",
    {
      method: "POST",
      clientToken,
      headers: idempotencyHeaders,
      body: { ...runBody, requestSha256: "7".repeat(64) },
    },
    409,
  );
  assert(
    idempotencyConflict.code === "IDEMPOTENCY_KEY_REUSED",
    "Idempotency-Key reuse with a different request was not rejected.",
  );
  const clientRunConflict = await requestJson(
    baseUrl,
    "/runs",
    {
      method: "POST",
      clientToken,
      headers: { "Idempotency-Key": "runtime-client-run-conflict" },
      body: runBody,
    },
    409,
  );
  assert(
    clientRunConflict.code === "CLIENT_RUN_ID_CONFLICT",
    "A clientRunId reused under a different idempotency key was not rejected.",
  );
  const events = await requestJson(
    baseUrl,
    `/runs/${run.id}/events?afterSequence=-1&limit=10`,
    { clientToken },
    200,
  );
  assert(
    events.length === 1 && events[0].sequence === 0,
    "Run event was not persisted.",
  );
  const liveSocket = await subscribeRun(apiPort, clientToken, run.id, 1);

  const workerId = randomUUID();
  let job;
  let retryRun;
  let retryJob;
  let integrityRun;
  let integrityJobId;
  let evidence;
  try {
    await requestJson(
      baseUrl,
      "/internal/workers/register",
      {
        method: "POST",
        workerToken,
        body: {
          id: workerId,
          displayName: "Runtime Worker",
          capabilities: ["context-freeze"],
        },
      },
      201,
    );
    const runningEventPromise = socketEventMatching(
      liveSocket,
      "run:event",
      (event) => event.runId === run.id && event.sequence === 1,
      5_000,
    );
    job = await requestJson(
      baseUrl,
      "/internal/jobs/claim",
      { method: "POST", workerToken, body: { workerId } },
      201,
    );
    assert(
      job.status === "leased" &&
        job.attemptCount === 1 &&
        typeof job.leaseId === "string",
      "Worker did not lease the queued job.",
    );
    const runningEvent = await runningEventPromise;
    assert(
      runningEvent.sequence === 1 && runningEvent.stage === "worker",
      "Worker claim did not publish the running Run event.",
    );
    await requestJson(
      baseUrl,
      `/internal/jobs/${job.id}/heartbeat`,
      {
        method: "POST",
        workerToken,
        body: { workerId, leaseId: job.leaseId },
      },
      201,
    );
    const passedEventPromise = socketEventMatching(
      liveSocket,
      "run:event",
      (event) => event.runId === run.id && event.sequence === 2,
      5_000,
    );
    await requestJson(
      baseUrl,
      `/internal/jobs/${job.id}/complete`,
      {
        method: "POST",
        workerToken,
        body: {
          workerId,
          leaseId: job.leaseId,
          status: "passed",
          resultSha256: "a".repeat(64),
        },
      },
      201,
    );
    const passedEvent = await passedEventPromise;
    assert(
      passedEvent.sequence === 2 && passedEvent.stage === "passed",
      "Job completion did not publish the terminal Run event.",
    );

    retryRun = await requestJson(
      baseUrl,
      "/runs",
      {
        method: "POST",
        clientToken,
        headers: { "Idempotency-Key": "runtime-retry-idempotency" },
        body: createRunBody(project.id, snapshot.id, {
          clientRunId: "runtime-retry-run",
          requestSha256: "8".repeat(64),
          scope: "runtime-retry",
        }),
      },
      201,
    );
    const deferredJobId = await deferQueuedJob(database, retryRun.id);
    const deferredClaim = await requestJson(
      baseUrl,
      "/internal/jobs/claim",
      { method: "POST", workerToken, body: { workerId } },
      201,
    );
    assert(
      deferredClaim === undefined,
      "Worker claimed a Job before its dispatch plan was ready.",
    );
    await activateDeferredJob(database, deferredJobId);
    const firstLease = await requestJson(
      baseUrl,
      "/internal/jobs/claim",
      { method: "POST", workerToken, body: { workerId } },
      201,
    );
    assert(
      firstLease.attemptCount === 1 && typeof firstLease.leaseId === "string",
      "Retry scenario did not create the first fenced lease.",
    );
    await expireLease(database, firstLease.id);
    retryJob = await requestJson(
      baseUrl,
      "/internal/jobs/claim",
      { method: "POST", workerToken, body: { workerId } },
      201,
    );
    assert(
      retryJob.id === firstLease.id &&
        retryJob.attemptCount === 2 &&
        typeof retryJob.leaseId === "string" &&
        retryJob.leaseId !== firstLease.leaseId,
      "Expired task was not reclaimed with a new fencing token.",
    );
    const staleLease = await requestJson(
      baseUrl,
      `/internal/jobs/${retryJob.id}/heartbeat`,
      {
        method: "POST",
        workerToken,
        body: { workerId, leaseId: firstLease.leaseId },
      },
      409,
    );
    assert(
      staleLease.code === "JOB_LEASE_MISMATCH",
      "A stale fencing token was not rejected.",
    );
    const missingLease = await requestJson(
      baseUrl,
      `/internal/jobs/${retryJob.id}/heartbeat`,
      { method: "POST", workerToken, body: { workerId } },
      409,
    );
    assert(
      missingLease.code === "WORKER_PROTOCOL_UPGRADE_REQUIRED",
      "A retried task accepted the legacy tokenless Worker protocol.",
    );
    await requestJson(
      baseUrl,
      `/internal/jobs/${retryJob.id}/heartbeat`,
      {
        method: "POST",
        workerToken,
        body: { workerId, leaseId: retryJob.leaseId },
      },
      201,
    );
    await assertReclaimedAttemptState(database, retryJob.id);
    evidence = await exerciseEvidenceApi({
      baseUrl,
      clientToken,
      projectId: project.id,
      runId: run.id,
      otherRunId: retryRun.id,
    });
    const integrity = await exerciseJobIntegrityQuarantine({
      baseUrl,
      clientToken,
      workerToken,
      database,
      workerId,
      projectId: project.id,
      snapshotId: snapshot.id,
      createRunBody,
    });
    integrityRun = { id: integrity.runId };
    integrityJobId = integrity.jobId;
    await expireLease(database, retryJob.id);
  } finally {
    liveSocket.close();
  }
  assert(job !== undefined, "Runtime job scenario did not create a job.");
  assert(
    retryRun !== undefined && retryJob !== undefined,
    "Runtime reaper scenario did not create a retried job.",
  );
  assert(
    integrityRun !== undefined && integrityJobId !== undefined,
    "Runtime integrity scenario did not create a quarantined job.",
  );
  assert(evidence !== undefined, "Runtime evidence scenario did not run.");
  return {
    projectId: project.id,
    snapshotId: snapshot.id,
    runId: run.id,
    jobId: job.id,
    retryRunId: retryRun.id,
    retryJobId: retryJob.id,
    integrityRunId: integrityRun.id,
    integrityJobId,
    artifactId: evidence.artifactId,
    inventoryId: evidence.inventoryId,
    workerId,
    authentication: {
      clientWithoutTokenStatus: 401,
      workerWithoutTokenStatus: 401,
    },
    idempotentCreate: true,
    concurrentIdempotentCreate: true,
    idempotencyConflictRejected: true,
    clientRunIdConflictRejected: true,
    worker: {
      registered: true,
      claimed: true,
      heartbeatRenewed: true,
      completed: true,
      reclaimedWithNewLease: true,
      staleLeaseRejected: true,
      tokenlessRetryRejected: true,
      deferredDispatchEnforced: true,
      integrityFailureQuarantined: true,
    },
    evidence: { httpOwnershipEnforced: evidence.httpOwnershipEnforced },
    liveEventsReceived: true,
  };
}

async function deferQueuedJob(database, runId) {
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

async function activateDeferredJob(database, jobId) {
  const [result] = await database.query(
    "UPDATE jobs SET dispatch_ready_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND dispatch_ready_at IS NULL",
    [jobId],
  );
  assert(
    result.affectedRows === 1,
    "Could not activate the deferred test Job.",
  );
}

function createRunBody(projectId, snapshotId, overrides = {}) {
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

async function expireLease(database, jobId) {
  const [result] = await database.query(
    "UPDATE jobs SET lease_expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ? AND status = 'leased'",
    [jobId],
  );
  assert(result.affectedRows === 1, "Could not expire the active test lease.");
}

async function assertReclaimedAttemptState(database, jobId) {
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
