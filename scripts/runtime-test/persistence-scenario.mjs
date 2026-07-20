import { delay, requestJson, verifyWebSocket } from "./api-support.mjs";
import { assert } from "./process.mjs";

const host = "127.0.0.1";

export async function verifyPersistence({
  apiPort,
  clientToken,
  runId,
  projectId,
  retryRunId,
  integrityRunId,
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
  const retryRun = await waitForRunStatus(
    baseUrl,
    clientToken,
    retryRunId,
    "failed",
  );
  const retryEvents = await requestJson(
    baseUrl,
    `/runs/${retryRunId}/events?afterSequence=-1&limit=10`,
    { clientToken },
    200,
  );
  assert(
    retryEvents.length === 3 && retryEvents[2].stage === "failed",
    "Reaper did not append exactly one terminal failure event.",
  );
  await delay(1_250);
  const eventsAfterSecondSweep = await requestJson(
    baseUrl,
    `/runs/${retryRunId}/events?afterSequence=-1&limit=10`,
    { clientToken },
    200,
  );
  assert(
    eventsAfterSecondSweep.length === retryEvents.length,
    "A repeated reaper sweep duplicated the terminal Run event.",
  );
  const integrityRun = await requestJson(
    baseUrl,
    `/runs/${integrityRunId}`,
    { clientToken },
    200,
  );
  const integrityEvents = await requestJson(
    baseUrl,
    `/runs/${integrityRunId}/events?afterSequence=-1&limit=10`,
    { clientToken },
    200,
  );
  assert(
    integrityRun.status === "blocked" &&
      integrityEvents.length === 3 &&
      integrityEvents[1].stage === "integrity" &&
      integrityEvents[2].stage === "blocked",
    "Quarantined Job state or event history was not persisted.",
  );
  return {
    persistedAfterRestart: true,
    reaper: {
      exhaustedJobFailed: retryRun.status === "failed",
      terminalEventDeduplicated: true,
    },
    integrity: {
      quarantinedAfterRestart: true,
      duplicateClaimPrevented: true,
    },
    webSocket: await verifyWebSocket(apiPort, clientToken, runId),
  };
}

async function waitForRunStatus(baseUrl, clientToken, runId, expectedStatus) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const run = await requestJson(
      baseUrl,
      `/runs/${runId}`,
      { clientToken },
      200,
    );
    if (run.status === expectedStatus) return run;
    await delay(100);
  }
  throw new Error(`Run did not reach ${expectedStatus} before timeout.`);
}
