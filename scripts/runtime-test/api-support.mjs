/**
 * @fileoverview 为真实 MySQL runtime scenario 提供有界 REST 与 Socket.IO 客户端、事件等待和稳定
 * JSON 摘要；不被生产服务导入，不绕过认证，也不保存响应正文。
 * @module scripts/runtime-test
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：api/evidence/persistence 等 scenario 调用本模块访问当前回环测试服务。输入是临时端口、
 * 测试 token、固定 path/DTO 和预期状态，输出为解析 JSON、Socket 或测试摘要。副作用包括本机
 * HTTP/WebSocket 请求和有界定时器。
 * 安全边界：token 只进入正确 header/握手 auth，不进入断言文本；请求 5 秒超时且 WebSocket
 * 禁止重连。通过只证明当前 runtime 场景，不证明公网 TLS、跨进程 dispatcher 或真实 Worker。
 */
import { createHash } from "node:crypto";
import { io } from "socket.io-client";
import { assert } from "./process.mjs";

/** runtime API 与 Socket.IO 只访问回环服务。 */
const host = "127.0.0.1";

/**
 * 发出一条有界 JSON REST 请求并断言精确状态码。
 * @param baseUrl 当前隔离服务的 `/v1` 回环 URL。
 * @param path 脚本内固定 API 相对路径，不应包含秘密。
 * @param options 方法、header、临时 client/worker token 与可选 DTO body。
 * @param expectedStatus 当前场景预期的精确 HTTP 状态。
 * @returns 空响应为 undefined，否则返回 JSON.parse 结果；调用方仍需断言业务结构。
 * @throws Error 网络/超时、非 JSON 响应或状态不匹配时抛出；失败文本不主动包含 token。
 */
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

/**
 * 建立一个 Run 实时订阅并验证初始 snapshot 数量。
 * @param port 当前隔离 API 端口。
 * @param token 临时 Client token，仅进入 Socket.IO auth。
 * @param runId 已由场景创建的 Run ID。
 * @param expectedSnapshotEvents 订阅时应从数据库恢复的事件数。
 * @returns 保持连接的 Socket，由调用方在 finally 中关闭。
 * @throws Error 连接、订阅 acknowledgment、snapshot 或数量验证失败时关闭 socket 后抛出。
 */
export async function subscribeRun(port, token, runId, expectedSnapshotEvents) {
  // 步骤 1：先注册 connect 等待再显式连接，避免快速事件丢失。
  const socket = createSocket(`http://${host}:${String(port)}/runs`, token);
  try {
    const connected = socketEvent(socket, "connect", 5_000);
    socket.connect();
    await connected;
    // 步骤 2：在发送订阅前注册 snapshot，随后同时验证 acknowledgment 与数据库恢复结果。
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

/**
 * 验证无效握手 token 被拒绝，以及合法订阅可恢复终态 Run 的连续事件历史。
 * @param port 当前隔离 API 端口。
 * @param token 临时合法 Client token。
 * @param runId 已完成且预期有三条权威事件的 Run ID。
 * @returns 两项验证均成功的布尔摘要；不返回 socket 或 token。
 * @throws Error 握手错误码、订阅确认、Run 状态或事件 sequence 不符合预期时抛出。
 */
export async function verifyWebSocket(port, token, runId) {
  const url = `http://${host}:${String(port)}/runs`;
  // 步骤 1：独立连接证明错误 token 在握手阶段被拒绝，不能进入订阅事件。
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

  // 步骤 2：合法连接订阅数据库权威历史；Socket.IO 只承载通知/快照，不是唯一事实源。
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

/**
 * 等待 Socket.IO 单次事件并施加截止时间。
 * @param socket 当前 scenario 创建的 socket。
 * @param event 固定事件名称。
 * @param timeoutMs 最大等待毫秒数。
 * @returns 第一个事件值。
 * @throws Error 截止时间内未收到事件时 reject。
 */
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

/**
 * 等待首个满足谓词的 Socket.IO 事件，并在完成/超时后移除 listener。
 * @param socket 当前 scenario 创建的 socket。
 * @param event 固定事件名称。
 * @param predicate 只检查测试预期字段的内存函数，不来自网络载荷。
 * @param timeoutMs 最大等待毫秒数。
 * @returns 首个 predicate 为真的事件值。
 * @throws Error 截止时间内没有匹配事件时 reject。
 */
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

/**
 * @param value 已通过 scenario 契约约束的 JSON 值。
 * @returns 旧版 localeCompare 稳定序列化后的大写 SHA-256，用于构造测试 payload 证据。
 */
export function sha256Json(value) {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)), "utf8")
    .digest("hex")
    .toUpperCase();
}

/** @param milliseconds 有界轮询等待毫秒数。 @returns 定时器触发后 resolve 的 Promise。 */
export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * 创建禁止重连、仅 WebSocket transport 的测试 Socket。
 * @param url 当前回环 `/runs` namespace URL。
 * @param token 临时测试 token，仅放入握手 auth。
 * @returns 尚未自动连接的 Socket.IO client。
 */
function createSocket(url, token) {
  return io(url, {
    auth: { token },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
}

/**
 * 发出带 callback 的 Socket.IO 事件并等待 5 秒内确认。
 * @param socket 已连接的测试 socket。
 * @param event 固定客户端事件名称。
 * @param payload 已由 scenario 构造的订阅 DTO。
 * @returns 服务端 acknowledgment 值。
 * @throws Error 5 秒内没有确认时 reject。
 */
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

/**
 * @param value 旧版稳定测试哈希输入。
 * @returns 递归复制且按 localeCompare 排序键的值；数组保持顺序，不修改输入。
 */
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
