/**
 * @fileoverview 静态检查 dist 中 JavaScript 的相对 `.js` import 目标是否存在；不执行构建产物、
 * 不解析 package exports，也不证明运行时依赖或业务行为正确。
 * @module scripts/gates
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：`npm run build` 在 Nest 编译后执行本脚本。输入是当前工作区 dist 文件树，输出为
 * 缺失相对导入清单或通过统计。副作用仅递归读取文件和检查路径可访问性。
 * 安全边界：只解析源码生成的静态相对 `.js` specifier，不跟随网络或执行模块；通过不证明服务
 * 能启动、数据库 migration 已执行或第三方 package 在目标平台可加载。
 */
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

/** 构建输出绝对根；脚本只在该目录下枚举 importer。 */
const distRoot = resolve("dist");
/** 提取静态相对 `.js` import/from specifier，不尝试解释动态 import 表达式。 */
const importPattern = /(?:from\s+|import\s*)["'](\.\.?\/[^"']+\.js)["']/gu;
/** 缺失目标的脱敏结构列表；值都是构建路径和 import specifier，不含源码载荷。 */
const missing = [];
let checkedFileCount = 0;

/**
 * 深度优先扫描 dist 中的 `.js` 文件。
 * @param directory 当前构建目录绝对路径。
 * @returns 当前子树全部候选文件完成检查后 resolve。
 * @throws Error 目录不可读时传播文件系统错误，门禁不得假装通过。
 */
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

/**
 * 读取一个构建文件并验证其中每个静态相对 `.js` 目标存在。
 * @param path walk 找到的构建 JavaScript 绝对路径。
 * @returns 文件读取与所有 access 检查完成后 resolve；缺失项追加到 missing。
 */
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

// 步骤 1：完整扫描后统一失败，使报告包含全部缺失目标而不是首个错误。
await walk(distRoot);
if (missing.length > 0) {
  throw new Error(
    `Production build has missing relative imports:\n${JSON.stringify(missing, null, 2)}`,
  );
}
// 步骤 2：零缺失只证明静态相对目标存在，输出不扩大到模块可执行性。
process.stdout.write(
  `${JSON.stringify({ status: "passed", checkedFileCount, missingImportCount: 0 }, null, 2)}\n`,
);
