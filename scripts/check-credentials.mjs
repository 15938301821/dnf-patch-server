/**
 * @fileoverview 扫描源码或构建文本中的高风险凭据字面量；不读取真实 Secret Manager、不验证凭据
 * 是否有效，也不输出匹配内容。
 * @module scripts/gates
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：`npm run check:credentials` 扫描源码，构建门禁以 `build` 模式扫描 dist。输入是 CLI
 * mode 与工作区文本文件，输出为脱敏发现位置或通过摘要。副作用仅递归读取文件和写 stdout/stderr。
 * 安全边界：拒绝符号链接和超大文本，避免逃逸扫描根或资源耗尽；规则是启发式门禁，通过不证明
 * 仓库、环境、历史提交或外部系统绝无秘密，真实匹配值永远不得进入报告。
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

/** CLI 选择的 source/build 扫描场景；其他值在任何文件读取前拒绝。 */
const mode = parseMode(process.argv[2]);
/** 调用命令的仓库根，用于限定路径并生成相对报告。 */
const projectRoot = process.cwd();
/** source 扫描仓库根，build 扫描生成后的 dist 根。 */
const scanRoot = mode === "source" ? projectRoot : resolve(projectRoot, "dist");
/** 单文本文件最大 5 MiB，防止门禁意外读取大对象或耗尽内存。 */
const maxTextFileBytes = 5 * 1024 * 1024;
/** source 模式递归时跳过的生成、依赖和版本控制目录。 */
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
/** 可安全按 UTF-8 文本读取并执行正则扫描的扩展名白名单。 */
const textExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);
/** 没有常规文本扩展名但属于源码配置面的文件白名单。 */
const textFileNames = new Set([".env.example", ".gitignore"]);
/**
 * 高风险字面量启发式规则；允许项只接受显式替换占位或脱敏标记。
 * 正则不得扩展为打印捕获组，避免门禁自身泄露疑似秘密。
 */
const rules = [
  {
    id: "openai-api-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu,
  },
  {
    id: "literal-bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{32,}\b/gu,
  },
  {
    id: "mysql-password-uri",
    pattern: /mysql:\/\/[^\s:@/]+:([^\s@/]+)@/giu,
    allow: (match) => match[1]?.startsWith("replace-with-") === true,
  },
  {
    id: "literal-shared-token",
    pattern:
      /\b(?:CLIENT_SHARED_TOKEN|WORKER_SHARED_TOKEN)\s*[=:]\s*["']([^"']{32,})["']/gu,
    allow: (match) =>
      match[1]?.startsWith("replace-with-") === true ||
      match[1]?.includes("[redacted]") === true,
  },
];

// 步骤 1：先以有界、拒绝符号链接的方式收集确定性文件列表。
const paths = await collectTextFiles(scanRoot);
const findings = [];
// 步骤 2：逐文件逐规则扫描，只保存规则、相对路径和行号，不保存匹配值。
for (const path of paths) {
  const content = await readFile(path, "utf8");
  for (const rule of rules) {
    for (const match of content.matchAll(rule.pattern)) {
      if (rule.allow?.(match)) continue;
      findings.push({
        ruleId: rule.id,
        path: relative(projectRoot, path).split(sep).join("/"),
        line: lineNumberAt(content, match.index),
      });
    }
  }
}

// 步骤 3：有发现时输出脱敏位置并失败；零发现时只输出范围统计。
if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `Credential risk ${finding.ruleId} at ${finding.path}:${String(finding.line)}; matched value withheld.\n`,
    );
  }
  throw new Error(`Credential scan found ${String(findings.length)} risk(s).`);
}
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: "passed",
      mode,
      scannedFileCount: paths.length,
      findingCount: 0,
      matchedValuesReported: false,
    },
    null,
    2,
  )}\n`,
);

/**
 * 递归收集扫描根内的有界文本文件，并拒绝任何符号链接。
 * @param root source 模式的仓库根或 build 模式的 dist 绝对路径。
 * @returns 按 localeCompare 排序的绝对文件路径；排序保证报告稳定。
 * @throws Error 遇到符号链接、超过 5 MiB 的候选文本或文件系统读取失败时抛出并中止门禁。
 */
async function collectTextFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Credential scan refuses symbolic links: ${entry.name}`,
        );
      }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          mode !== "source" ||
          !ignoredDirectories.has(entry.name.toLowerCase())
        ) {
          await visit(path);
        }
        continue;
      }
      if (!entry.isFile() || !isTextFile(path)) continue;
      const item = await lstat(path);
      if (item.size > maxTextFileBytes) {
        throw new Error(`Text file exceeds credential scan limit: ${path}`);
      }
      files.push(path);
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * @param path collectTextFiles 遇到的候选文件路径。
 * @returns 文件名或扩展名在受支持文本白名单中时为 true。
 */
function isTextFile(path) {
  const name = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return textFileNames.has(name) || textExtensions.has(extname(name));
}

/**
 * @param content 当前 UTF-8 文件全文。
 * @param index 正则匹配的零基字符偏移，缺失时按文件首行处理。
 * @returns 供脱敏报告定位的一基行号。
 */
function lineNumberAt(content, index = 0) {
  return content.slice(0, index).split("\n").length;
}

/**
 * @param value CLI 第一个参数。
 * @returns 精确的 `source` 或 `build` 模式。
 * @throws Error 缺失或未知模式时抛出，防止误扫未定义路径。
 */
function parseMode(value) {
  if (value === "source" || value === "build") return value;
  throw new Error("Credential scan mode must be source or build.");
}
