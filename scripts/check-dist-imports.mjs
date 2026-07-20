import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const distRoot = resolve("dist");
const importPattern = /(?:from\s+|import\s*)["'](\.\.?\/[^"']+\.js)["']/gu;
const missing = [];
let checkedFileCount = 0;

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (entry.isFile() && extname(entry.name) === ".js") {
      await checkFile(path);
    }
  }
}

async function checkFile(path) {
  checkedFileCount += 1;
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const target = resolve(dirname(path), specifier);
    try {
      await access(target);
    } catch {
      missing.push({ importer: path, specifier, target });
    }
  }
}

await walk(distRoot);
if (missing.length > 0) {
  throw new Error(
    `Production build has missing relative imports:\n${JSON.stringify(missing, null, 2)}`,
  );
}
process.stdout.write(
  `${JSON.stringify({ status: "passed", checkedFileCount, missingImportCount: 0 }, null, 2)}\n`,
);
