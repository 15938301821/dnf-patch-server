import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const projectRoot = process.cwd();
const requiredDirectories = [
  ".codebuddy/rules",
  "drizzle/meta",
  "plan/jobs/JOB-001-SHARED-FX",
  "plan/meta",
  "scripts/runtime-test",
  "src/common/contracts",
  "src/common/db",
  "src/common/http",
  "src/common/security",
  "src/common/utils",
  "src/config",
  "src/modules",
];
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
  "plan/meta/job_list.json",
  "plan/meta/style_guide.md",
  "plan/meta/tier_def.json",
  "scripts/check-credentials.mjs",
  "scripts/check-dist-imports.mjs",
  "scripts/check-migrations.mjs",
  "scripts/smoke-dist.mjs",
  "scripts/test-mysql-runtime.mjs",
  "src/app.module.spec.ts",
  "src/app.module.ts",
  "src/main.ts",
  "tsconfig.build.json",
  "tsconfig.json",
  "vitest.config.ts",
];
const requiredModuleFiles = {
  artifact: ["contracts", "controller", "module", "repository", "service"],
  factory: ["contracts", "controller", "module", "repository", "service"],
  guardrail: ["contracts", "controller", "module", "service"],
  health: ["controller", "module", "service"],
  image: ["contracts", "controller", "module", "service"],
  job: ["contracts", "controller", "module", "repository", "service"],
  npk: ["contracts", "controller", "module", "repository", "service"],
  openai: ["contracts", "module", "service"],
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
const moduleClassNames = {
  artifact: "ArtifactModule",
  factory: "FactoryModule",
  guardrail: "GuardrailModule",
  health: "HealthModule",
  image: "ImageModule",
  job: "JobModule",
  npk: "NpkModule",
  openai: "OpenAiModule",
  project: "ProjectModule",
  run: "RunModule",
  worker: "WorkerModule",
};
const forbiddenCompatibilityPaths = [
  "src/controllers",
  "src/repositories",
  "src/services",
  "src/shared",
  "src/server",
];

await validateStructure();

async function validateStructure() {
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
    "utils",
  ]);
  await assertExactChildren("src/modules", Object.keys(requiredModuleFiles));

  for (const [moduleName, fileRoles] of Object.entries(requiredModuleFiles)) {
    await assertPath(`src/modules/${moduleName}`, "directory");
    for (const role of fileRoles) {
      await assertPath(
        `src/modules/${moduleName}/${moduleName}.${role}.ts`,
        "file",
      );
    }
  }

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
  for (const dependency of ["@nestjs/core", "drizzle-orm", "mysql2"]) {
    assert(
      typeof packageJson.dependencies?.[dependency] === "string",
      `Required backend dependency is missing: ${dependency}`,
    );
  }

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

  const tierDefinition = await readJson("plan/meta/tier_def.json");
  assert(
    tierDefinition.schemaVersion === 1 &&
      Array.isArray(tierDefinition.tiers) &&
      tierDefinition.tiers.length > 0,
    "tier_def must contain at least one versioned tier.",
  );

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

async function assertExactChildren(relativePath, expectedChildren) {
  const actual = (await readdir(pathFromRoot(relativePath))).sort();
  const expected = [...expectedChildren].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Directory structure differs at ${relativePath}: ${JSON.stringify({ actual, expected })}`,
  );
}

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

async function pathExists(relativePath) {
  try {
    await stat(pathFromRoot(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(pathFromRoot(relativePath), "utf8"));
}

function pathFromRoot(relativePath) {
  const path = resolve(projectRoot, relativePath);
  const prefix = projectRoot.endsWith(sep)
    ? projectRoot
    : `${projectRoot}${sep}`;
  assert(path.startsWith(prefix), `Path escapes project root: ${relativePath}`);
  return path;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
