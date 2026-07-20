import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, extname, join } from "node:path";

const host = "127.0.0.1";

export async function resolveMysqlIdentity() {
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
  const versionOutput = (
    await runProcess(path, ["--no-defaults", "--version"])
  ).output.trim();
  const versionMatch = /\bVer\s+([^\s]+)/u.exec(versionOutput);
  if (!versionMatch) {
    throw new Error("Could not parse the installed MySQL version.");
  }
  return {
    path,
    basedir: dirname(dirname(path)),
    mysqlAdminPath,
    version: versionMatch[1],
    sha256: await sha256File(path),
  };
}

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

export function assertRunning(processHandle, label) {
  if (hasExited(processHandle)) {
    throw processFailure(
      processHandle,
      `${label} exited before becoming ready.`,
    );
  }
}

export function processFailure(processHandle, message) {
  return new Error(
    `${message}\nProcess output:\n${sanitize(processHandle.capturedOutput)}`,
  );
}

export function sanitize(value) {
  return String(value ?? "")
    .replace(/mysql:\/\/[^\s@]+@/giu, "mysql://[redacted]@")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

export function errorMessage(error) {
  return sanitize(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
}

export function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasExited(processHandle) {
  return processHandle.exitCode !== null || processHandle.signalCode !== null;
}

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

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex").toUpperCase()));
  });
}
