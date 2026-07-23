/**
 * @fileoverview 验证持久化 Job 载荷哈希被篡改后，Server 会 fail-closed 隔离 Job 与 Run；不验证真实 Worker 执行、Artifact 内容或部署结果。
 * @module scripts/runtime-test/job-integrity-scenario
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：api-scenario 调用导出的完整性场景；下游通过回环 Worker/Client API 与隔离 MySQL 连接交叉核验错误响应、持久化状态和权威事件。
 * 输入：测试 API 地址、随机 Client/Worker token、隔离数据库连接及已创建的 Worker/Project/Snapshot。输出：被隔离 Run 与 Job 的 ID，供重启持久化场景继续验证。
 * 副作用：创建一个测试 Run，并仅在隔离数据库中故意改写 queued Job 的 payload_sha256；随后触发 claim 和读取事件，不接触生产数据。
 * 安全/验证边界：Job 完整性校验必须在发出租约前执行；失败后清空租约、阻断 Run 并追加事件，后续 claim 不得再次选中该 Job。场景通过不证明原始 payload 业务正确或候选补丁兼容。
 */
import { requestJson } from "./api-support.mjs";
import { assert } from "./process.mjs";

/**
 * 构造持久化哈希篡改并验证 Job 完整性隔离的完整闭环。
 *
 * @param baseUrl 隔离 Server 的 /v1 回环地址。
 * @param clientToken 用于创建和读取 Run 的随机普通客户端凭据。
 * @param workerToken 用于 claim 内部接口且与 Client token 分离的随机凭据。
 * @param database 隔离 MySQL 连接，仅用于测试注入篡改并核验权威行。
 * @param workerId 已注册且具备目标 Job capability 的 Worker ID。
 * @param projectId 已创建测试 Project 的 ID。
 * @param snapshotId 归属于该 Project 的冻结 Snapshot ID。
 * @param createRunBody 上层场景提供的合法 Run DTO 工厂。
 * @returns 被隔离的 runId 与 jobId，供服务重启后的持久化核验使用。
 * @throws 任一稳定错误码、租约清理、终态或事件顺序不符合预期时抛出。
 */
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
  // 步骤 1：通过公开 API 创建合法 Run，确保篡改发生在服务已持久化的声明式 Job 上。
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
  // 步骤 2：仅在隔离数据库破坏 payload 哈希，再请求 claim 触发服务端完整性门禁。
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
  // 步骤 3：再次 claim 必须跳过已隔离 Job，防止损坏载荷被后续 Worker 领取。
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
  // 步骤 4：交叉核验数据库租约字段、Run 终态和权威事件，避免只信任 HTTP 错误表象。
  await assertIntegrityQuarantine(
    database,
    baseUrl,
    clientToken,
    run.id,
    jobId,
  );
  return { runId: run.id, jobId };
}

/**
 * 在隔离数据库中破坏一个 queued Job 的持久化载荷哈希，模拟静默数据篡改。
 *
 * @param database 隔离 MySQL 连接；SQL 参数化且 runId 来自刚创建的测试 Run。
 * @param runId 当前完整性场景创建的 Run ID。
 * @returns 被篡改且原本处于 queued 状态的唯一 Job ID。
 * @throws 找不到唯一 Job 或更新行数不为一时抛出，防止误改不确定记录。
 */
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

/**
 * 核验完整性失败已原子地隔离 Job、清空租约并阻断所属 Run。
 *
 * @param database 隔离 MySQL 连接，用于读取权威 Job 行。
 * @param baseUrl 隔离 Server 的回环 API 地址。
 * @param clientToken 有效普通客户端凭据，仅用于读取 Run 与事件。
 * @param runId 应进入 blocked 终态的测试 Run ID。
 * @param jobId 应进入 blocked 且无租约状态的测试 Job ID。
 * @returns 所有数据库与 API 断言通过后完成。
 * @throws Job 状态、租约清理、Run 状态或事件顺序任一不匹配时抛出。
 */
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
