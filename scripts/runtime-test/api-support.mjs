import { createHash } from "node:crypto";
import { io } from "socket.io-client";
import { assert } from "./process.mjs";

const host = "127.0.0.1";

export async function requestJson(baseUrl, path, options, expectedStatus) {
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

export async function subscribeRun(port, token, runId, expectedSnapshotEvents) {
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

export async function verifyWebSocket(port, token, runId) {
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

export function socketEvent(socket, event, timeoutMs) {
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

export function socketEventMatching(socket, event, predicate, timeoutMs) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      rejectEvent(new Error(`Socket event ${event} timed out.`));
    }, timeoutMs);
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolveEvent(value);
    };
    socket.on(event, listener);
  });
}

export function sha256Json(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)), "utf8")
    .digest("hex")
    .toUpperCase();
}

export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
