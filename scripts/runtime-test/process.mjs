/**
 * @fileoverview 为显式 MySQL runtime test 提供受控进程、端口、关闭、输出脱敏与文件哈希工具；
 * 不被 Nest 服务导入，不接收 HTTP/Worker 参数，也不是通用命令执行 API。
 * @module scripts/runtime-test
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：test-mysql-runtime 及各 runtime scenario 只用固定 Node/mysqld 路径和参数调用本模块。
 * 输入是测试编排生成的可执行路径、参数、环境和进程句柄，输出是子进程/结果或脱敏错误。副作用
 * 包括占用回环端口、启动/终止本机测试进程、读取 mysqld 二进制并保留最多 30 KiB 输出。
 * 安全边界：所有 spawn 固定 `shell:false`，MYSQLD_PATH 必须解析为常规 mysqld 且相邻 mysqladmin
 * 存在；错误输出必须先脱敏数据库 URL 与 Bearer token。该能力不得迁入服务运行时或接收网络输入。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, extname, join } from "node:path";

/** runtime test 只绑定本机回环接口，避免临时 MySQL/API 暴露到外部网卡。 */
const host = "127.0.0.1";

/**
 * 校验显式 MYSQLD_PATH、相邻 mysqladmin、版本和二进制摘要。
 * @returns 已规范化的 mysqld/mysqladmin 路径、basedir、版本与大写 SHA-256。
 * @throws Error 配置缺失、路径不是常规 mysqld、mysqladmin 缺失、版本无法解析或文件读取失败时抛出。
 */
export async function resolveMysqlIdentity() {
  // 步骤 1：只接受调用者显式配置的本机 mysqld，禁止 PATH 搜索或下载任意可执行文件。
  const configuredPath = process.env.MYSQLD_PATH;
  if (!configuredPath) {
    throw new Error(
      "MYSQLD_PATH must point to an installed mysqld executable.",
    );
  }
  const path = await realpath(configuredPath);
  const file = await stat(path);
  if (!file.isFile() || !/^mysqld(?:\.exe)?$/iu.test(basename(path))) {
    throw new Error("MYSQLD_PATH must resolve to a regular mysqld executable.");
  }
  const suffix = extname(path).toLowerCase() === ".exe" ? ".exe" : "";
  const mysqlAdminPath = join(dirname(path), `mysqladmin${suffix}`);
  if (!(await stat(mysqlAdminPath)).isFile()) {
    throw new Error("mysqladmin was not found beside mysqld.");
  }
  // 步骤 2：使用固定 `--no-defaults --version` 参数确认身份，不读取系统 MySQL 配置文件。
  const versionOutput = (
    await runProcess(path, ["--no-defaults", "--version"])
  ).output.trim();
  const versionMatch = /\bVer\s+([^\s]+)/u.exec(versionOutput);
  if (!versionMatch) {
    throw new Error("Could not parse the installed MySQL version.");
  }
  // 步骤 3：记录可执行文件摘要用于结果审计；这不证明供应链可信或跨平台兼容。
  return {
    path,
    basedir: dirname(dirname(path)),
    mysqlAdminPath,
    version: versionMatch[1],
    sha256: await sha256File(path),
  };
}

/**
 * 向操作系统申请一个临时回环 TCP 端口并立即释放。
 * @returns 当次探测得到的端口号；后续进程绑定前仍存在竞争窗口。
 * @throws Error 无法监听、读取地址或关闭探测 socket 时抛出。
 */
export async function findFreePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, host, resolveListen);
  });
  const address = server.address();
  assert(
    address !== null && typeof address !== "string",
    "Could not allocate a runtime test port.",
  );
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return port;
}

/**
 * 以非 shell 模式启动固定测试进程，并有界捕获 stdout/stderr。
 * @param executable 测试编排已校验的 Node 或 mysqld/mysqladmin 路径，不能来自 API。
 * @param args 脚本内固定构造的参数数组，不经 shell 解释。
 * @param options 可选 cwd、环境与上层超时配置；环境可能含临时秘密，不写入输出。
 * @returns 带 `capturedOutput` 的 ChildProcess 句柄，由调用方负责 finally 清理。
 * @throws Error spawn 同步失败时由 Node 传播；异步启动错误通过句柄事件暴露。
 */
export function startProcess(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.capturedOutput = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      child.capturedOutput = `${child.capturedOutput}${String(chunk)}`.slice(
        -30_000,
      );
    });
  }
  return child;
}

/**
 * 启动一次性测试进程并等待零退出码，超时后强制终止。
 * @param executable 受控 Node/MySQL 可执行路径。
 * @param args 固定参数数组。
 * @param options 可含 cwd/env 与 timeoutMs；默认超时 15 秒。
 * @returns 零退出时返回有界捕获输出。
 * @throws Error spawn、超时或非零退出时抛出经 processFailure 组装的脱敏错误。
 */
export async function runProcess(executable, args, options = {}) {
  const child = startProcess(executable, args, options);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOutcome(
        processFailure(
          child,
          `Process timed out after ${String(timeoutMs)} milliseconds.`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectOutcome(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveOutcome({ code, signal });
    });
  });
  if (outcome.code !== 0) {
    throw processFailure(
      child,
      `Process exited with code ${String(outcome.code)} and signal ${String(outcome.signal)}.`,
    );
  }
  return { output: child.capturedOutput };
}

/**
 * 先请求正常终止，5 秒未退出再 SIGKILL，并再次有界等待。
 * @param processHandle startProcess 返回的子进程句柄。
 * @param label 不含凭据的进程说明，用于清理失败错误。
 * @returns 进程已退出或被成功终止后 resolve；重复调用已退出进程是幂等的。
 * @throws Error 两阶段共 10 秒后仍未退出时抛出脱敏进程错误。
 */
export async function stopChild(processHandle, label) {
  if (hasExited(processHandle)) return;
  const gracefulExit = waitForExit(processHandle, 5_000);
  processHandle.kill();
  if (await gracefulExit) return;
  const forcedExit = waitForExit(processHandle, 5_000);
  processHandle.kill("SIGKILL");
  if (!(await forcedExit)) {
    throw processFailure(processHandle, `${label} did not stop in 10 seconds.`);
  }
}

/**
 * 优先使用相邻 mysqladmin 对隔离实例执行 TCP shutdown，失败后回退通用进程终止。
 * @param processHandle 当前隔离 mysqld 句柄。
 * @param identity resolveMysqlIdentity 返回的固定 mysqladmin 身份。
 * @param port runtime test 分配的隔离回环端口，绝不使用系统 3306。
 * @returns MySQL 已退出后 resolve。
 * @throws Error 优雅与强制清理都失败时抛出；不会吞掉最终清理失败。
 */
export async function stopMysql(processHandle, identity, port) {
  if (hasExited(processHandle)) return;
  try {
    await runProcess(
      identity.mysqlAdminPath,
      [
        "--protocol=TCP",
        `--host=${host}`,
        `--port=${String(port)}`,
        "--user=root",
        "shutdown",
      ],
      { timeoutMs: 10_000 },
    );
    if (await waitForExit(processHandle, 10_000)) return;
  } catch {
    // The bounded termination fallback still guarantees process cleanup.
  }
  await stopChild(processHandle, "Isolated MySQL");
}

/**
 * @param processHandle 预期仍在启动或运行的子进程。
 * @param label 不含秘密的场景名称。
 * @returns 进程尚未退出时无值返回。
 * @throws Error 进程已退出时抛出包含脱敏有界输出的失败。
 */
export function assertRunning(processHandle, label) {
  if (hasExited(processHandle)) {
    throw processFailure(
      processHandle,
      `${label} exited before becoming ready.`,
    );
  }
}

/**
 * @param processHandle 带有有界 capturedOutput 的测试进程。
 * @param message 不含秘密的稳定失败上下文。
 * @returns 包含 sanitize 后进程输出的新 Error；不返回原始环境。
 */
export function processFailure(processHandle, message) {
  return new Error(
    `${message}\nProcess output:\n${sanitize(processHandle.capturedOutput)}`,
  );
}

/**
 * 对测试错误文本进行最小凭据脱敏。
 * @param value 子进程输出或异常文本。
 * @returns 隐去 MySQL URL 用户信息段和 Bearer token 的字符串。
 * @remarks 这是日志兜底而非完整秘密扫描，调用方仍不得主动输出环境或 payload。
 */
export function sanitize(value) {
  return String(value ?? "")
    .replace(/mysql:\/\/[^\s@]+@/giu, "mysql://[redacted]@")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

/**
 * @param error 任意捕获值。
 * @returns 优先使用 Error stack 的脱敏文本，否则脱敏字符串表示。
 */
export function errorMessage(error) {
  return sanitize(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
}

/**
 * @param milliseconds 测试编排固定的非负等待毫秒数。
 * @returns 指定定时器触发后 resolve 的 Promise；仅供有截止时间的轮询使用。
 */
export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * @param condition 当前 runtime 不变量。
 * @param message 不含秘密的失败说明。
 * @throws Error condition 为假时抛出；为真时无副作用。
 */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param processHandle 子进程句柄。 @returns 已有 exitCode 或 signalCode 时为 true。 */
function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

/**
 * @param processHandle 待观察的子进程句柄。
 * @param timeoutMs 最长等待毫秒数。
 * @returns 期限内收到 exit 时为 true，超时为 false；不主动终止进程。
 */
function waitForExit(processHandle, timeoutMs) {
  if (hasExited(processHandle)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(false), timeoutMs);
    processHandle.once("exit", () => {
      clearTimeout(timer);
      resolveWait(true);
    });
  });
}

/**
 * 流式计算本机已校验可执行文件摘要，避免一次读入内存。
 * @param path resolveMysqlIdentity 得到的常规 mysqld 绝对路径。
 * @returns 大写 SHA-256 十六进制摘要。
 * @throws Error 文件打开或读取失败时 reject。
 */
function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex").toUpperCase()));
  });
}
