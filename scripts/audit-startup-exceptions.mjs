/**
 * @fileoverview Audits production startup with V8 pause-on-all-exceptions enabled.
 * It does not suppress dependency exceptions or replace application tests.
 * @module scripts
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A (direct startup debugging request)
 */
import { resolve } from "node:path";
import WebSocket from "ws";
import {
  assert,
  delay,
  findFreePort,
  processFailure,
  startProcess,
  stopChild,
} from "./runtime-test/process.mjs";

const host = "127.0.0.1";
const apiPort = await findFreePort();
const child = startProcess(
  process.execPath,
  ["--inspect-brk=0", resolve("dist/main.js")],
  {
    env: {
      ...process.env,
      NODE_ENV: "development",
      HOST: host,
      PORT: String(apiPort),
    },
  },
);

let inspector;
try {
  const inspectorUrl = await waitForInspectorUrl(child);
  inspector = await connectInspector(inspectorUrl);
  const exceptions = [];
  let runtimeInternalPauseCount = 0;
  inspector.onPause((event) => {
    if (isEntryPause(event)) {
      void inspector.resume();
      return;
    }
    const pause = describePause(event, inspector.scriptUrl);
    if (pause.runtimeInternal) {
      runtimeInternalPauseCount += 1;
    } else {
      exceptions.push(pause);
    }
    void inspector.resume();
  });

  await inspector.post("Runtime.enable");
  await inspector.post("Debugger.enable");
  await inspector.post("Debugger.setBlackboxPatterns", {
    patterns: ["^node:internal(?:/|$)"],
  });
  await inspector.post("Debugger.setPauseOnExceptions", { state: "all" });
  await inspector.post("Runtime.runIfWaitingForDebugger");

  const initialHealth = await waitForHealth(child, apiPort);
  assert(
    initialHealth.status === "ok" && initialHealth.database === "available",
    `Startup health was not ready: ${JSON.stringify(initialHealth)}.`,
  );

  await delay(6_500);
  const settledHealth = await readHealth(apiPort);
  assert(
    settledHealth.status === "ok" && settledHealth.database === "available",
    `Settled health was not ready: ${JSON.stringify(settledHealth)}.`,
  );
  assert(
    exceptions.length === 0,
    `Startup threw exceptions while pause-on-all-exceptions was active:\n${JSON.stringify(exceptions, null, 2)}`,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        pauseOnExceptions: "all",
        blackboxedRuntime: "node:internal/**",
        runtimeInternalPauseCount,
        exceptionCount: exceptions.length,
        healthStatus: settledHealth.status,
        database: settledHealth.database,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  throw processFailure(
    child,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  if (inspector) {
    await inspector.close();
  }
  await stopChild(child, "Startup exception audit process");
}

async function waitForInspectorUrl(processHandle) {
  const existing = inspectorUrl(processHandle.capturedOutput);
  if (existing) return existing;

  return await new Promise((resolveUrl, rejectUrl) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectUrl(new Error("Node Inspector did not start within 10 seconds."));
    }, 10_000);
    const inspectChunk = (chunk) => {
      const url = inspectorUrl(String(chunk));
      if (!url) return;
      cleanup();
      resolveUrl(url);
    };
    const handleExit = (code) => {
      cleanup();
      rejectUrl(
        new Error(
          `Audited process exited before Inspector attach: ${String(code)}.`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      processHandle.stdout.off("data", inspectChunk);
      processHandle.stderr.off("data", inspectChunk);
      processHandle.off("exit", handleExit);
    };
    processHandle.stdout.on("data", inspectChunk);
    processHandle.stderr.on("data", inspectChunk);
    processHandle.once("exit", handleExit);
  });
}

function inspectorUrl(value) {
  return /Debugger listening on (ws:\/\/[^\s]+)/u.exec(value)?.[1];
}

async function waitForHealth(processHandle, port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `Audited process exited with code ${String(processHandle.exitCode)}.`,
      );
    }
    try {
      return await readHealth(port);
    } catch {
      await delay(100);
    }
  }
  throw new Error("Audited service did not become healthy within 15 seconds.");
}

async function readHealth(port) {
  const response = await fetch(`http://${host}:${String(port)}/v1/health`, {
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) {
    throw new Error(`Health request returned ${String(response.status)}.`);
  }
  return await response.json();
}

function isEntryPause(event) {
  return event.reason === "Break on start";
}

function describePause(event, scriptUrl) {
  const frames = event.callFrames ?? [];
  const throwingFrame = frames[0];
  const visibleFrames = frames.filter(
    (frame) => !isNodeInternal(frameUrl(frame, scriptUrl)),
  );
  const visibleFrame = visibleFrames[0] ?? throwingFrame;
  return {
    reason: event.reason,
    uncaught: event.data?.uncaught === true,
    runtimeInternal: visibleFrames.length === 0,
    location: normalizeLocation(frameUrl(visibleFrame, scriptUrl)),
    line: visibleFrame ? visibleFrame.location.lineNumber + 1 : undefined,
    functionName: visibleFrame?.functionName || undefined,
    className: event.data?.className,
    description: boundedDescription(event.data?.description),
  };
}

function frameUrl(frame, scriptUrl) {
  if (!frame) return "";
  return frame.url || scriptUrl(frame.location.scriptId) || "";
}

function isNodeInternal(value) {
  return value.startsWith("node:internal/");
}

function normalizeLocation(value) {
  if (!value) return "unknown";
  const normalized = value.replaceAll("\\", "/");
  const dependencyIndex = normalized.lastIndexOf("/node_modules/");
  if (dependencyIndex !== -1) {
    return normalized.slice(dependencyIndex + 1);
  }
  const workspace = process.cwd().replaceAll("\\", "/");
  return normalized.startsWith(workspace)
    ? normalized.slice(workspace.length + 1)
    : normalized;
}

function boundedDescription(value) {
  return typeof value === "string" ? value.slice(0, 300) : undefined;
}

async function connectInspector(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  return createInspectorSession(socket);
}

function createInspectorSession(socket) {
  let nextId = 1;
  const pendingRequests = new Map();
  const scriptUrls = new Map();
  let pauseHandler;
  socket.on("message", (data) => handleMessage(String(data)));

  function onPause(handler) {
    pauseHandler = handler;
  }

  function post(method, params = {}) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolvePost, rejectPost) => {
      pendingRequests.set(id, { resolvePost, rejectPost });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function resume() {
    try {
      await post("Debugger.resume");
    } catch {
      // Closing the audit process can race a final resume response.
    }
  }

  async function close() {
    if (socket.readyState === WebSocket.CLOSED) return;
    try {
      await post("Debugger.setPauseOnExceptions", { state: "none" });
    } finally {
      socket.close();
    }
  }

  function handleMessage(raw) {
    const message = JSON.parse(raw);
    if (typeof message.id === "number") {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.rejectPost(new Error(message.error.message));
      } else {
        pending.resolvePost(message.result);
      }
      return;
    }
    if (message.method === "Debugger.scriptParsed") {
      scriptUrls.set(message.params.scriptId, message.params.url);
      return;
    }
    if (message.method === "Debugger.paused") {
      pauseHandler?.(message.params);
    }
  }

  return {
    onPause,
    post,
    resume,
    close,
    scriptUrl: (scriptId) => scriptUrls.get(scriptId),
  };
}
