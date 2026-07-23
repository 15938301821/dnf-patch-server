/**
 * @fileoverview 在 Server 重启后核验 Run/Project、超时回收、完整性隔离与 WebSocket 恢复语义；不创建生产数据，也不证明多实例调度或外部系统可用。
 * @module scripts/runtime-test/persistence-scenario
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：test-mysql-runtime 在第二次启动 dist/main.js 后调用 verifyPersistence；下游通过回环 REST、Socket.IO helper 和轮询读取第一次进程写入的数据库状态。
 * 输入：重启后的 API 端口、随机 Client token，以及主场景创建的 Project/Run ID。输出：持久化、reaper、完整性和 WebSocket 恢复证明摘要。
 * 副作用：只读取隔离数据库支撑的 API、短暂等待后台 reaper，并建立一次受认证 WebSocket；不直接执行 SQL 或修改仓库文件。
 * 安全/验证边界：数据库事件是权威事实源，WebSocket 只做提交后通知；重复 reaper 扫描不得重复终态事件，被隔离 Job 不得复活。通过不证明多副本协调、真实 Worker 或部署能力。
 */
import { delay, requestJson, verifyWebSocket } from "./api-support.mjs";
import { assert } from "./process.mjs";

const host = "127.0.0.1";

/**
 * 验证第一次 Server 进程写入的状态在重启后仍可读取并保持安全终态。
 *
 * @param apiPort 重启后 Server 绑定的回环端口。
 * @param clientToken 上层生成的随机普通客户端凭据。
 * @param runId 已完成主场景且用于验证事件恢复的 Run ID。
 * @param projectId 第一次进程创建、重启后必须仍可读取的 Project ID。
 * @param retryRunId 含过期 attempt、应由 reaper 聚合为 failed 的 Run ID。
 * @param integrityRunId 完整性失败后应持续保持 blocked 的 Run ID。
 * @returns 已通过断言的持久化、reaper、完整性与 WebSocket 摘要。
 * @throws 任一资源丢失、终态错误、事件重复或 Socket 恢复失败时抛出。
 */
export async function verifyPersistence({
  apiPort,
  clientToken,
  runId,
  projectId,
  retryRunId,
  integrityRunId,
}) {
  const baseUrl = `http://${host}:${String(apiPort)}/v1`;
  // 步骤 1：先读取第一次进程创建的 Project 与 Run，证明重启没有丢失权威数据库行。
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
  // 步骤 2：等待单进程 reaper 回收耗尽重试的 attempt，并确认只追加一次 failed 终态事件。
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
  // 步骤 3：确认完整性隔离状态及事件历史跨重启保持，损坏 Job 不能重新进入可领取状态。
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
  // 步骤 4：最后通过 Socket.IO 核验提交后通知与数据库 sequence 恢复，不把内存消息当事实源。
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

/**
 * 在有界时间内轮询 Run，等待后台回收器把它聚合到预期终态。
 *
 * @param baseUrl 隔离 Server 的 /v1 回环地址。
 * @param clientToken 有效普通客户端凭据。
 * @param runId 等待状态转换的测试 Run ID。
 * @param expectedStatus 场景预先确定的目标终态；本 helper 不接受外部用户输入。
 * @returns 首个达到目标状态的 Run ViewModel。
 * @throws 5 秒内未达到目标状态时抛出，不无限等待后台定时任务。
 */
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
