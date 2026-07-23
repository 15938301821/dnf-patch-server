/**
 * @fileoverview 校验服务端仓库的稳定目录、必需文件、模块角色、依赖和安全配置锚点；不解析全部
 * TypeScript 语义、不修改项目，也不证明业务测试或外部集成通过。
 * @module scripts/gates
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：`npm run validate:project` 和 gate 执行本脚本。输入是当前工作区文件树与若干 JSON/
 * TypeScript 文本，输出为结构摘要或首个不变量错误。副作用仅读取文件和写 stdout。
 * 安全边界：pathFromRoot 防止动态相对路径逃逸仓库；禁止兼容双轨目录、任意执行策略和缺失固定
 * 模块入口。通过只证明声明式项目骨架，不证明源码注释、类型、测试、migration 或服务运行正确。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** 调用脚本时的仓库根，所有动态路径都必须由 pathFromRoot 约束在其下。 */
const projectRoot = process.cwd();
/** 架构要求存在的目录快照；新增稳定层级时必须显式审查并更新。 */
const requiredDirectories = [
  ".codebuddy/rules",
  "drizzle/meta",
  "plan/jobs/JOB-001-SHARED-FX",
  "plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE",
  "plan/meta",
  "scripts/runtime-test",
  "src/common/contracts",
  "src/common/db",
  "src/common/http",
  "src/common/security",
  "src/common/storage",
  "src/common/utils",
  "src/config",
  "src/modules",
];
/** 构建、规则、计划、门禁与应用入口的必需文件快照。 */
const requiredFiles = [
  ".codebuddy/rules/global.md",
  ".codebuddy/rules/server.md",
  ".env.example",
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "docker-compose.yml",
  "drizzle.config.ts",
  "drizzle/meta/_journal.json",
  "eslint.config.js",
  "mcp.json",
  "nest-cli.json",
  "package-lock.json",
  "package.json",
  "plan/jobs/JOB-001-SHARED-FX/requirements.md",
  "plan/jobs/JOB-001-SHARED-FX/task.md",
  "plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE/requirements.md",
  "plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE/task.md",
  "plan/meta/job_list.json",
  "plan/meta/style_guide.md",
  "plan/meta/tier_def.json",
  "scripts/check-credentials.mjs",
  "scripts/check-dist-imports.mjs",
  "scripts/check-migrations.mjs",
  "scripts/minio-bootstrap.sh",
  "scripts/smoke-dist.mjs",
  "scripts/test-mysql-runtime.mjs",
  "src/app.module.spec.ts",
  "src/app.module.ts",
  "src/main.ts",
  "tsconfig.build.json",
  "tsconfig.json",
  "vitest.config.ts",
];
/** 每个纵向模块必须提供的基础文件角色；值是 `<module>.<role>.ts` 的 role。 */
const requiredModuleFiles = {
  artifact: ["contracts", "controller", "module", "repository", "service"],
  auth: ["contracts", "controller", "module", "service"],
  factory: ["contracts", "controller", "module", "repository", "service"],
  guardrail: ["contracts", "controller", "module", "service"],
  health: ["controller", "module", "service"],
  image: ["contracts", "controller", "module", "service"],
  job: ["contracts", "controller", "module", "repository", "service"],
  "model-configuration": ["contracts", "controller", "module", "service"],
  npk: ["contracts", "controller", "module", "repository", "service"],
  openai: ["contracts", "module", "service"],
  profession: ["contracts", "controller", "module", "repository", "service"],
  project: ["contracts", "controller", "module", "repository", "service"],
  run: [
    "contracts",
    "controller",
    "gateway",
    "module",
    "repository",
    "service",
  ],
  worker: ["contracts", "controller", "module", "service"],
};
/** AppModule 中必须导入并注册的 Nest Module 类名映射。 */
const moduleClassNames = {
  artifact: "ArtifactModule",
  auth: "AuthModule",
  factory: "FactoryModule",
  guardrail: "GuardrailModule",
  health: "HealthModule",
  image: "ImageModule",
  job: "JobModule",
  "model-configuration": "ModelConfigurationModule",
  npk: "NpkModule",
  openai: "OpenAiModule",
  profession: "ProfessionModule",
  project: "ProjectModule",
  run: "RunModule",
  worker: "WorkerModule",
};
/** 禁止出现的旧式横向兼容目录，避免 Controller/Service/Repository 双轨架构。 */
const forbiddenCompatibilityPaths = [
  "src/controllers",
  "src/repositories",
  "src/services",
  "src/shared",
  "src/server",
];

await validateStructure();

/**
 * 执行完整项目结构门禁，按“路径 -> 模块 -> package -> 配置/计划 -> migration”顺序检查。
 * @returns 全部静态不变量满足后输出通过摘要并 resolve。
 * @throws Error 任一目录、文件、模块注册、依赖或安全配置锚点不匹配时立即失败。
 */
async function validateStructure() {
  // 步骤 1：先验证必需/禁止路径和顶层精确子目录，防止后续读取错误位置。
  for (const path of requiredDirectories) await assertPath(path, "directory");
  for (const path of requiredFiles) await assertPath(path, "file");
  for (const path of forbiddenCompatibilityPaths) {
    assert(
      !(await pathExists(path)),
      `Compatibility path must not exist: ${path}`,
    );
  }

  await assertExactChildren("src", [
    "app.module.spec.ts",
    "app.module.ts",
    "common",
    "config",
    "main.ts",
    "modules",
  ]);
  await assertExactChildren("src/common", [
    "contracts",
    "db",
    "http",
    "security",
    "storage",
    "utils",
  ]);
  await assertExactChildren("src/modules", Object.keys(requiredModuleFiles));

  // 步骤 2：逐模块验证纵向角色文件，避免回退为并行 controllers/services 目录。
  for (const [moduleName, fileRoles] of Object.entries(requiredModuleFiles)) {
    await assertPath(`src/modules/${moduleName}`, "directory");
    for (const role of fileRoles) {
      await assertPath(
        `src/modules/${moduleName}/${moduleName}.${role}.ts`,
        "file",
      );
    }
  }

  // 步骤 3：核对 ESM、门禁入口与基础设施依赖的声明存在性，不执行依赖代码。
  const packageJson = await readJson("package.json");
  assert(packageJson.type === "module", "package.json must use ESM.");
  assert(
    packageJson.scripts?.["validate:project"] ===
      "node scripts/validate-project.mjs",
    "package.json validate:project script is missing or changed.",
  );
  assert(
    packageJson.scripts?.gate?.includes("npm run validate:project") === true,
    "package.json gate must include validate:project.",
  );
  for (const dependency of [
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "@nestjs/core",
    "drizzle-orm",
    "mysql2",
  ]) {
    assert(
      typeof packageJson.dependencies?.[dependency] === "string",
      `Required backend dependency is missing: ${dependency}`,
    );
  }

  // 步骤 4：文本检查根模块注册与固定模型 ID；此处不替代 TypeScript AST 或外部模型探测。
  const appModule = await readFile(pathFromRoot("src/app.module.ts"), "utf8");
  for (const [moduleName, className] of Object.entries(moduleClassNames)) {
    assert(
      appModule.includes(`./modules/${moduleName}/${moduleName}.module.js`),
      `AppModule does not import the ${moduleName} module entrypoint.`,
    );
    assert(
      appModule.includes(className),
      `AppModule does not register ${className}.`,
    );
  }

  const environment = await readFile(
    pathFromRoot("src/config/environment.ts"),
    "utf8",
  );
  for (const modelId of ["gpt-5.6-sol", "gpt-5.5", "gpt-image-2"]) {
    assert(
      environment.includes(modelId),
      `Fixed model identity is missing: ${modelId}`,
    );
  }

  // 步骤 5：验证部署示例只声明必需键、MCP 默认拒绝任意网络/执行以及计划元数据有版本。
  const environmentExample = await readFile(
    pathFromRoot(".env.example"),
    "utf8",
  );
  for (const variable of [
    "MYSQL_PASSWORD",
    "MYSQL_ROOT_PASSWORD",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "OBJECT_STORAGE_ACCESS_KEY",
    "OBJECT_STORAGE_SECRET_KEY",
  ]) {
    assert(
      new RegExp(`^${variable}=.+$`, "mu").test(environmentExample),
      `.env.example must define the Compose-required ${variable}.`,
    );
  }

  const mcp = await readJson("mcp.json");
  assert(mcp.schemaVersion === 1, "mcp.json schemaVersion must be 1.");
  assert(Array.isArray(mcp.servers), "mcp.json servers must be an array.");
  assert(
    mcp.policy?.networkDefault === "deny" &&
      mcp.policy?.arbitraryExecution === false,
    "mcp.json must deny network and arbitrary execution by default.",
  );

  const jobList = await readJson("plan/meta/job_list.json");
  assert(jobList.schemaVersion === 1, "job_list schemaVersion must be 1.");
  assert(Array.isArray(jobList.jobs), "job_list jobs must be an array.");
  const jobIds = jobList.jobs.map((job) => job.id);
  assert(
    new Set(jobIds).size === jobIds.length,
    "job_list contains duplicate job IDs.",
  );
  assert(
    jobIds.includes("JOB-006-LOCAL-OBJECT-STORAGE"),
    "job_list must register the local object storage implementation task.",
  );

  const tierDefinition = await readJson("plan/meta/tier_def.json");
  assert(
    tierDefinition.schemaVersion === 1 &&
      Array.isArray(tierDefinition.tiers) &&
      tierDefinition.tiers.length > 0,
    "tier_def must contain at least one versioned tier.",
  );

  // 步骤 6：最后确认至少存在一份版本化 migration，再输出静态结构证明范围。
  const migrationFiles = (await readdir(pathFromRoot("drizzle")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  assert(migrationFiles.length > 0, "At least one SQL migration is required.");

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "passed",
        sourceLayers: ["common", "config", "modules"],
        moduleCount: Object.keys(requiredModuleFiles).length,
        modules: Object.keys(requiredModuleFiles),
        migrationCount: migrationFiles.length,
        fixedModelIds: ["gpt-5.6-sol", "gpt-5.5", "gpt-image-2"],
        mcpNetworkDefault: mcp.policy.networkDefault,
        arbitraryExecution: mcp.policy.arbitraryExecution,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * 比较目录的精确直接子项集合。
 * @param relativePath 已知仓库内目录的相对路径。
 * @param expectedChildren 规则固定的直接子项名称，不递归。
 * @returns 集合完全一致时 resolve。
 * @throws Error 出现缺失或额外子项时抛出，避免悄然创建兼容双轨目录。
 */
async function assertExactChildren(relativePath, expectedChildren) {
  const actual = (await readdir(pathFromRoot(relativePath))).sort();
  const expected = [...expectedChildren].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Directory structure differs at ${relativePath}: ${JSON.stringify({ actual, expected })}`,
  );
}

/**
 * @param relativePath 规则声明的仓库相对路径。
 * @param expectedKind 预期为 `file` 或 `directory`。
 * @returns 路径存在且类型匹配时 resolve。
 * @throws Error 路径缺失、类型错误或 stat 失败时抛出脱敏结构错误。
 */
async function assertPath(relativePath, expectedKind) {
  let item;
  try {
    item = await stat(pathFromRoot(relativePath));
  } catch {
    throw new Error(`Required ${expectedKind} is missing: ${relativePath}`);
  }
  assert(
    expectedKind === "file" ? item.isFile() : item.isDirectory(),
    `Required path is not a ${expectedKind}: ${relativePath}`,
  );
}

/**
 * @param relativePath 仓库内候选相对路径。
 * @returns 路径可 stat 时为 true；任何 stat 失败按不存在处理。
 */
async function pathExists(relativePath) {
  try {
    await stat(pathFromRoot(relativePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param relativePath 规则固定的仓库内 JSON 路径。
 * @returns JSON.parse 后的值；调用点仍需逐字段校验。
 * @throws SyntaxError 文件不是合法 JSON 时传播并使门禁失败。
 */
async function readJson(relativePath) {
  return JSON.parse(await readFile(pathFromRoot(relativePath), "utf8"));
}

/**
 * 将动态相对路径解析到仓库根并阻止 `..` 等逃逸。
 * @param relativePath 由本脚本常量或受控循环组合的相对路径。
 * @returns 位于 projectRoot 子树内的绝对路径。
 * @throws Error 解析结果不是仓库根的后代时抛出。
 */
function pathFromRoot(relativePath) {
  const path = resolve(projectRoot, relativePath);
  const prefix = projectRoot.endsWith(sep)
    ? projectRoot
    : `${projectRoot}${sep}`;
  assert(path.startsWith(prefix), `Path escapes project root: ${relativePath}`);
  return path;
}

/**
 * @param condition 当前结构不变量判定。
 * @param message 不含凭据的稳定门禁错误说明。
 * @throws Error condition 为假时抛出；为真时无返回副作用。
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
