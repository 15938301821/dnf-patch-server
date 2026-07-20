import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const mode = parseMode(process.argv[2]);
const projectRoot = process.cwd();
const scanRoot = mode === "source" ? projectRoot : resolve(projectRoot, "dist");
const maxTextFileBytes = 5 * 1024 * 1024;
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
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
const textFileNames = new Set([".env.example", ".gitignore"]);
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

const paths = await collectTextFiles(scanRoot);
const findings = [];
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

function isTextFile(path) {
  const name = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return textFileNames.has(name) || textExtensions.has(extname(name));
}

function lineNumberAt(content, index = 0) {
  return content.slice(0, index).split("\n").length;
}

function parseMode(value) {
  if (value === "source" || value === "build") return value;
  throw new Error("Credential scan mode must be source or build.");
}
