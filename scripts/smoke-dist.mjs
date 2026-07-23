/**
 * @fileoverview 对已构建的 Server 生产入口执行降级冒烟验证；不连接真实 MySQL、对象存储、模型或 Worker，也不证明完整业务链路可用。
 * @module scripts/smoke-dist
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：由构建门禁在生成 dist 后直接执行；下游启动 dist/main.js，并通过回环 HTTP 请求检查健康、认证和 CORS 边界。
 * 输入：当前进程环境中的非敏感基础配置；脚本覆盖端口和测试凭据，并主动移除对象存储凭据。输出：向 stdout 写入脱敏的冒烟结果，失败时附带有界子进程输出。
 * 副作用：占用临时回环端口、启动并终止一个生产构建子进程，不写数据库或仓库文件。
 * 安全/验证边界：随机 token 只存在于子进程环境；数据库故意不可用且健康状态必须降级，匿名业务请求必须拒绝，凭据型 CORS 只能回显白名单来源。通过不代表真实 MySQL、外部 Provider 或部署已验证。
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";

const host = "127.0.0.1";
const apiPort = await findFreePort();
const databasePort = await findFreePort();
const clientToken = randomBytes(24).toString("hex");
const workerToken = randomBytes(24).toString("hex");
const browserSessionSecret = randomBytes(32).toString("hex");
const environment = {
  ...process.env,
  NODE_ENV: "test",
  HOST: host,
  PORT: String(apiPort),
  CORS_ORIGINS: "http://127.0.0.1:3000",
  DATABASE_URL: `mysql://runtime-probe@${host}:${String(databasePort)}/dnf_patch`,
  DATABASE_POOL_SIZE: "1",
  DNF_REPOSITORY_ROOT: "../dnf-patch",
  CLIENT_SHARED_TOKEN: clientToken,
  WORKER_SHARED_TOKEN: workerToken,
  BROWSER_SESSION_SECRET: browserSessionSecret,
  MODEL_CREDENTIAL_MASTER_KEY: randomBytes(32).toString("base64url"),
  OBJECT_STORAGE_ENABLED: "false",
  OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  OBJECT_STORAGE_REGION: "us-east-1",
  OBJECT_STORAGE_BUCKET: "dnf-patch-artifacts",
  OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
  OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: "300",
  OBJECT_STORAGE_MAX_OBJECT_BYTES: "2147483648",
  OBJECT_STORAGE_MAX_RUN_BYTES: "10737418240",
  OPENAI_BASE_URL: "https://kldai.cc/v1",
  OPENAI_ORCHESTRATOR_MODEL: "gpt-5.6-sol",
  OPENAI_ENGINEER_MODEL: "gpt-5.5",
  OPENAI_IMAGE_MODEL: "gpt-image-2",
  WORKER_LEASE_SECONDS: "60",
};
delete environment.OBJECT_STORAGE_ACCESS_KEY;
delete environment.OBJECT_STORAGE_SECRET_KEY;

const child = spawn(process.execPath, [resolve("dist/main.js")], {
  cwd: process.cwd(),
  env: environment,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-20_000);
  });
}

try {
  // 步骤 1：等待生产构建启动，并确认数据库不可用时只暴露预期的 degraded 健康摘要。
  const health = await waitForHealth(child, apiPort);
  if (
    health.schemaVersion !== 1 ||
    health.status !== "degraded" ||
    health.service !== "dnf-patch-server" ||
    health.database !== "unavailable"
  ) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  // 步骤 2：匿名访问受保护资源必须在进入业务逻辑前被认证门禁拒绝。
  const protectedResponse = await fetch(
    `http://${host}:${String(apiPort)}/v1/projects`,
    { signal: AbortSignal.timeout(2_000) },
  );
  if (protectedResponse.status !== 401) {
    throw new Error(
      `Unauthenticated project request returned ${String(protectedResponse.status)}.`,
    );
  }
  // 步骤 3：凭据型 CORS 预检必须精确匹配允许来源，不能退化为通配放行。
  const corsOrigin = "http://127.0.0.1:3000";
  const preflightResponse = await fetch(
    `http://${host}:${String(apiPort)}/v1/auth/refresh`,
    {
      method: "OPTIONS",
      headers: {
        Origin: corsOrigin,
        "Access-Control-Request-Method": "POST",
      },
      signal: AbortSignal.timeout(2_000),
    },
  );
  if (
    preflightResponse.status !== 204 ||
    preflightResponse.headers.get("access-control-allow-origin") !==
      corsOrigin ||
    preflightResponse.headers.get("access-control-allow-credentials") !== "true"
  ) {
    throw new Error(
      "Credentialed CORS preflight did not preserve the allowlist.",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ status: "passed", healthStatus: health.status, database: health.database, unauthenticatedProjectsStatus: protectedResponse.status, credentialedCorsOrigin: corsOrigin }, null, 2)}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}\nProduction process output:\n${output}`);
} finally {
  // 无论断言是否失败都回收子进程，避免门禁遗留监听端口。
  await stopChild(child);
}

/**
 * 向操作系统申请当前可用的回环 TCP 端口，并在返回前释放探测监听器。
 *
 * @returns 可供随后子进程绑定的端口号；返回只反映探测时刻，不构成跨进程端口预留。
 * @throws 监听或关闭失败、地址不是 TCP 地址时抛出。
 */
async function findFreePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a runtime probe port.");
  }
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

/**
 * 在有界启动窗口内轮询生产服务健康端点。
 *
 * @param processHandle 已启动的 dist/main.js 子进程，用于检测提前退出。
 * @param port 本脚本分配给生产服务的回环端口。
 * @returns 第一个成功健康响应解析出的 JSON；字段语义由上层继续严格断言。
 * @throws 子进程提前退出或 12 秒内没有成功响应时抛出。
 */
async function waitForHealth(processHandle, port) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `Production process exited with code ${String(processHandle.exitCode)}.`,
      );
    }
    try {
      const response = await fetch(`http://${host}:${String(port)}/v1/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Startup races are retried until the bounded deadline.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    "Production service did not become healthy within 12 seconds.",
  );
}

/**
 * 先请求子进程正常退出，超时后再强制终止，并确认最终确已退出。
 *
 * @param processHandle 冒烟测试创建且由本脚本独占管理的生产子进程。
 * @returns 子进程退出后完成，不返回业务结果。
 * @throws 两阶段终止窗口结束后进程仍未退出时抛出。
 */
async function stopChild(processHandle) {
  if (hasExited(processHandle)) return;
  const gracefulExit = once(processHandle, "exit");
  processHandle.kill();
  await Promise.race([
    gracefulExit,
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ]);
  if (!hasExited(processHandle)) {
    const forcedExit = once(processHandle, "exit");
    processHandle.kill("SIGKILL");
    await Promise.race([
      forcedExit,
      new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
    ]);
  }
  if (!hasExited(processHandle)) {
    throw new Error("Production smoke process did not stop within 6 seconds.");
  }
}

/**
 * 判断子进程是否已经以退出码或信号进入终态。
 *
 * @param processHandle Node.js ChildProcess 句柄。
 * @returns 任一终态标记已设置时返回 true。
 */
function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}
