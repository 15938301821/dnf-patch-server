/**
 * @fileoverview 为真实 Inventory 门禁构建 remote Renderer、建立一次性浏览器用户、启动回环预览，
 * 执行专用 Playwright 场景并复核服务端会话撤销；不修改前端业务逻辑或使用 Mock API。
 * @module scripts/runtime-test/inventory-real-browser
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 用户直接要求整体真实数据测试
 *
 * 调用关系：test-inventory-real 在 Server/Worker 完成官方 NPK 导入后调用本模块。输入为随机端口、
 * 一次性账号和当前资源摘要；输出为脱敏浏览器证据。副作用限于注册临时用户、重建受管 dist-web、
 * 启动 Vite preview 和 Playwright Chromium；测试输出写入总编排 sandbox，最终统一清理。
 * 安全边界：注册 token 和密码只进入回环请求/子进程环境，不进入报告；Playwright 关闭 trace、视频
 * 和截图，避免把表单凭据写入持久产物。通过不证明公网 TLS、Electron remote API 或最终包下载。
 */
import { join } from "node:path";
import { requestJson } from "./api-support.mjs";
import {
  assert,
  assertRunning,
  delay,
  processFailure,
  runProcess,
  startProcess,
} from "./process.mjs";

const host = "127.0.0.1";

/** 使用公开注册契约创建仅存于隔离数据库的一次性用户，不保留响应中的会话 token。 */
export async function registerRealBrowserUser(baseUrl, secrets) {
  const response = await requestJson(
    baseUrl,
    "/auth/register",
    {
      method: "POST",
      body: {
        username: secrets.browserUsername,
        password: secrets.browserPassword,
        displayName: secrets.browserDisplayName,
        registrationToken: secrets.browserRegistrationToken,
      },
    },
    201,
  );
  assert(
    response.data?.user?.username === secrets.browserUsername &&
      response.data?.user?.displayName === secrets.browserDisplayName &&
      typeof response.data?.accessToken === "string",
    "Browser user registration returned an invalid session.",
  );
}

/** 用随机真实 API 基址构建 remote Renderer；Vite 只会向客户端暴露两个 `VITE_` 值。 */
export async function buildRealBrowser(frontendRoot, apiBaseUrl) {
  await runProcess(
    process.execPath,
    [
      viteCli(frontendRoot),
      "build",
      "--config",
      join(frontendRoot, "vite.config.ts"),
      "--mode",
      "remote-e2e",
    ],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        VITE_API_MODE: "remote",
        VITE_API_BASE_URL: apiBaseUrl,
      },
      timeoutMs: 120_000,
    },
  );
}

/** 启动只绑定随机回环端口的 Vite preview；句柄由总编排 finally 负责停止。 */
export function startRealBrowserPreview(frontendRoot, browserPort) {
  return startProcess(
    process.execPath,
    [
      viteCli(frontendRoot),
      "preview",
      "--config",
      join(frontendRoot, "vite.config.ts"),
      "--host",
      host,
      "--port",
      String(browserPort),
      "--strictPort",
    ],
    { cwd: frontendRoot },
  );
}

/** 等待真实构建首页可读取，并拒绝把 preview 提前退出或超时当作就绪。 */
export async function waitForRealBrowserPreview(processHandle, browserPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assertRunning(processHandle, "Real Browser Preview");
    try {
      const response = await fetch(`http://${host}:${String(browserPort)}/`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok && (await response.text()).includes("DNF Patch Studio")) {
        return;
      }
    } catch {
      // Preview 启动窗口内连接拒绝是预期重试条件；进程退出和截止仍会失败。
    }
    await delay(100);
  }
  throw processFailure(processHandle, "Real Browser Preview did not start.");
}

/** 执行专用 remote Playwright 用例；测试配置禁止凭据相关 trace、截图和视频落盘。 */
export async function runRealBrowserScenario({
  frontendRoot,
  browserPort,
  outputPath,
  secrets,
  sourceSha256,
}) {
  await runProcess(
    process.execPath,
    [
      join(frontendRoot, "node_modules", "@playwright", "test", "cli.js"),
      "test",
      "--config",
      join(frontendRoot, "tests", "remote-playwright.config.ts"),
    ],
    {
      cwd: frontendRoot,
      env: {
        ...process.env,
        REAL_BROWSER_BASE_URL: `http://${host}:${String(browserPort)}`,
        REAL_BROWSER_OUTPUT_DIR: outputPath,
        REAL_BROWSER_USERNAME: secrets.browserUsername,
        REAL_BROWSER_PASSWORD: secrets.browserPassword,
        REAL_BROWSER_DISPLAY_NAME: secrets.browserDisplayName,
        REAL_BROWSER_SOURCE_SHA256: sourceSha256,
      },
      timeoutMs: 120_000,
    },
  );
}

/** 直接核对浏览器登出已撤销数据库会话，且持久化值只有 64 位 Refresh Token 摘要。 */
export async function inspectRealBrowserSession(database, username) {
  const [rows] = await database.query(
    "SELECT users.display_name AS displayName, browser_sessions.refresh_token_sha256 AS refreshTokenSha256, browser_sessions.revoked_at AS revokedAt FROM users INNER JOIN browser_sessions ON browser_sessions.user_id = users.id WHERE users.normalized_username = ?",
    [username.toLowerCase()],
  );
  const row = rows[0];
  assert(
    rows.length === 1 &&
      row.displayName === "Real Browser E2E User" &&
      /^[A-Fa-f0-9]{64}$/u.test(row.refreshTokenSha256) &&
      row.revokedAt !== null,
    "Browser logout did not preserve a revoked digest-only session.",
  );
  return {
    apiMode: "remote",
    loginVerified: true,
    resourceOverviewVerified: true,
    cookieRefreshVerified: true,
    browserTokenStorage: "memory-only",
    logoutRevoked: true,
  };
}

function viteCli(frontendRoot) {
  return join(frontendRoot, "node_modules", "vite", "bin", "vite.js");
}
