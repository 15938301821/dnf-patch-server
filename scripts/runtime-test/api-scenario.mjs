import { createHash, randomUUID } from "node:crypto";
import { io } from "socket.io-client";
import { assert } from "./process.mjs";

const host = "127.0.0.1";

export async function exerciseApi({ apiPort, clientToken, workerToken }) {
  const baseUrl = `http://${host}:${String(apiPort)}/v1`;
  await requestJson(baseUrl, "/projects", {}, 401);
  await requestJson(
    baseUrl,
    "/internal/jobs/claim",
    { method: "POST", body: { workerId: randomUUID() } },
    401,
  );

  const config = {
    schemaVersion: 1,
    profileId: "runtime-profile",
    policyId: "runtime-policy",
    allowedJobKinds: ["context-freeze"],
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
        id: "runtime-factory-v1",
        version: "1.0.0",
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
  const run = await requestJson(
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
    const runningEventPromise = socketEvent(liveSocket, "run:event", 5_000);
    job = await requestJson(
      baseUrl,
      "/internal/jobs/claim",
      { method: "POST", workerToken, body: { workerId } },
      201,
    );
    assert(
      job.status === "leased" && job.attemptCount === 1,
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
      { method: "POST", workerToken, body: { workerId } },
      201,
    );
    const passedEventPromise = socketEvent(liveSocket, "run:event", 5_000);
    await requestJson(
      baseUrl,
      `/internal/jobs/${job.id}/complete`,
      {
        method: "POST",
        workerToken,
        body: {
          workerId,
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
  } finally {
    liveSocket.close();
  }
  assert(job !== undefined, "Runtime job scenario did not create a job.");
  return {
    projectId: project.id,
    runId: run.id,
    jobId: job.id,
    workerId,
    authentication: {
      clientWithoutTokenStatus: 401,
      workerWithoutTokenStatus: 401,
    },
    idempotentCreate: true,
    worker: {
      registered: true,
      claimed: true,
      heartbeatRenewed: true,
      completed: true,
    },
    liveEventsReceived: true,
  };
}

export async function verifyPersistence({
  apiPort,
  clientToken,
  runId,
  projectId,
}) {
  const baseUrl = `http://${host}:${String(apiPort)}/v1`;
  const project = await requestJson(
    baseUrl,
    `/projects/${projectId}`,
    { clientToken },
    200,
  );
  const run = await requestJson(
    baseUrl,
    `/runs/${runId}`,
    { clientToken },
    200,
  );
  assert(
    project.id === projectId && run.id === runId,
    "Restarted service did not read persisted rows.",
  );
  return {
    persistedAfterRestart: true,
    webSocket: await verifyWebSocket(apiPort, clientToken, runId),
  };
}

function createRunBody(projectId, snapshotId) {
  return {
    projectId,
    snapshotId,
    clientRunId: "runtime-run",
    action: "validate-only",
    requestSha256: "5".repeat(64),
    serverConnectionEnabled: true,
    modelEgressAuthorized: false,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    jobs: [
      {
        kind: "context-freeze",
        payload: { scope: "runtime-integration" },
        maxAttempts: 2,
      },
    ],
    policyId: "runtime-policy",
    policySha256: "6".repeat(64),
  };
}

async function verifyWebSocket(port, token, runId) {
  const url = `http://${host}:${String(port)}/runs`;
  const rejected = createSocket(url, "invalid-runtime-token");
  try {
    const rejectionPromise = socketEvent(rejected, "connect_error", 5_000);
    rejected.connect();
    const rejection = await rejectionPromise;
    assert(
      rejection.message === "CLIENT_AUTH_FAILED",
      "Socket.IO accepted an invalid token.",
    );
  } finally {
    rejected.close();
  }

  const socket = createSocket(url, token);
  try {
    const connected = socketEvent(socket, "connect", 5_000);
    socket.connect();
    await connected;
    const snapshotPromise = socketEvent(socket, "run:snapshot", 5_000);
    const acknowledgment = await socketAcknowledgment(socket, "run:subscribe", {
      runId,
      afterSequence: -1,
    });
    const snapshot = await snapshotPromise;
    assert(
      acknowledgment.status === "subscribed",
      "Run subscription was not acknowledged.",
    );
    assert(snapshot.run.id === runId, "Run snapshot returned the wrong Run.");
    assert(snapshot.run.status === "passed", "Run snapshot was not terminal.");
    assert(
      snapshot.events.length === 3,
      "Run snapshot event history is incomplete.",
    );
    assert(
      snapshot.events.every((event, index) => event.sequence === index),
      "Run snapshot event sequence is not contiguous.",
    );
  } finally {
    socket.close();
  }
  return { invalidTokenRejected: true, snapshotReceived: true };
}

async function subscribeRun(port, token, runId, expectedSnapshotEvents) {
  const socket = createSocket(`http://${host}:${String(port)}/runs`, token);
  try {
    const connected = socketEvent(socket, "connect", 5_000);
    socket.connect();
    await connected;
    const snapshotPromise = socketEvent(socket, "run:snapshot", 5_000);
    const acknowledgment = await socketAcknowledgment(socket, "run:subscribe", {
      runId,
      afterSequence: -1,
    });
    const snapshot = await snapshotPromise;
    assert(
      acknowledgment.status === "subscribed",
      "Live Run subscription was not acknowledged.",
    );
    assert(
      snapshot.events.length === expectedSnapshotEvents,
      "Live Run snapshot returned an unexpected event count.",
    );
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

function createSocket(url, token) {
  return io(url, {
    auth: { token },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
}

async function requestJson(baseUrl, path, options, expectedStatus) {
  const headers = { ...(options.headers ?? {}) };
  if (options.clientToken) {
    headers.Authorization = `Bearer ${options.clientToken}`;
  }
  if (options.workerToken) {
    headers["X-Worker-Token"] = options.workerToken;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : undefined;
  assert(
    response.status === expectedStatus,
    `${options.method ?? "GET"} ${path} returned ${String(response.status)}: ${text}`,
  );
  return payload;
}

function socketEvent(socket, event, timeoutMs) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(
      () => rejectEvent(new Error(`Socket event ${event} timed out.`)),
      timeoutMs,
    );
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolveEvent(value);
    });
  });
}

function socketAcknowledgment(socket, event, payload) {
  return new Promise((resolveAck, rejectAck) => {
    const timer = setTimeout(
      () => rejectAck(new Error(`Socket acknowledgment ${event} timed out.`)),
      5_000,
    );
    socket.emit(event, payload, (acknowledgment) => {
      clearTimeout(timer);
      resolveAck(acknowledgment);
    });
  });
}

function sha256Json(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)), "utf8")
    .digest("hex")
    .toUpperCase();
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
