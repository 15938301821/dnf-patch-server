/**
 * @fileoverview 在隔离 MySQL 服务上执行 REST、Worker lease、事件、证据与完整性主场景；不调用真实 Worker 工具、对象存储、模型或部署流程。
 * @module scripts/runtime-test
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 * 调用关系：test-mysql-runtime 调用 exerciseApi，下游复用 api-support、evidence 与 integrity scenario；输入是临时端口/token/数据库连接，输出为后续重启核验使用的 ID 与证明摘要。
 * 副作用与边界：经回环 API 和测试数据库创建/篡改记录、建立短期 Socket；所有资源由上层 finally 清理。通过不证明外部模型、真实 Worker、MinIO、客户端兼容或部署，租约/归属缺证据必须 fail-closed。
 */
import { randomUUID } from "node:crypto";
import {
  requestJson,
  sha256Json,
  socketEventMatching,
  subscribeRun,
} from "./api-support.mjs";
import { exerciseJobIntegrityQuarantine } from "./job-integrity-scenario.mjs";
import { exerciseEvidenceApi } from "./evidence-scenario.mjs";
import { exerciseProfessionSkillProduction } from "./profession-skill-production-scenario.mjs";
import {
  activateDeferredJob,
  assertReclaimedAttemptState,
  createRunBody,
  deferQueuedJob,
  expireLease,
} from "./api-scenario-support.mjs";
import { assert } from "./process.mjs";

const host = "127.0.0.1";
/** @param apiPort 隔离服务端口；@param clientToken/workerToken 上层随机临时凭据；@param database 隔离 MySQL 连接。@returns 创建的 Project/Run/Job/Artifact 等 ID 与场景结果。@throws 任一认证、幂等、租约、事件或证据不变量失败时抛出。 */
export async function exerciseApi({
  apiPort,
  clientToken,
  workerToken,
  database,
}) {
  const baseUrl = `http://${host}:${String(apiPort)}/v1`;
  // 步骤 1：先证明普通与内部入口匿名请求均在 Controller 前被拒绝。
  await requestJson(baseUrl, "/projects", {}, 401);
  await requestJson(
    baseUrl,
    "/internal/jobs/claim",
    { method: "POST", body: { workerId: randomUUID() } },
    401,
  );
  // 步骤 2：创建冻结 Factory、Project、Snapshot 与 Run，并验证并发幂等和冲突语义。
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
  // 步骤 3：注册 Worker 后依次验证 claim、心跳、完成及事务提交后的实时事件。
  const workerId = randomUUID();
  let job;
  let retryRun;
  let retryJob;
  let integrityRun;
  let integrityJobId;
  let evidence;
  let professionSkillProduction;
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
    // 步骤 4：人为延迟/过期隔离 Job，验证 dispatch 门禁、重领 fencing 与旧协议拒绝。
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
      database,
      projectId: project.id,
      runId: run.id,
      otherRunId: retryRun.id,
    });
    professionSkillProduction = await exerciseProfessionSkillProduction({
      baseUrl,
      workerToken,
      database,
      projectId: project.id,
      snapshotId: snapshot.id,
      sourceRunId: run.id,
      workerId,
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
    // Socket 不是权威状态源，成功失败都关闭；后续重启从数据库事件恢复。
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
  assert(
    professionSkillProduction !== undefined,
    "Runtime Profession skill production scenario did not run.",
  );
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
    professionSkillProduction,
    liveEventsReceived: true,
  };
}
