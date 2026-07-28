/**
 * @fileoverview 将已审计的 31 个技术组件连接到成功 Inventory Run 的 417 条真实 Entry，
 * 并准备独立的维吉尔技术风格；不把技术组件解释成中文技能，也不创建任务、执行工具或部署文件。
 * @module scripts/runtime-test
 * @author AI生成
 * @created 2026-07-27
 * @relatedPlan N/A - 用户直接要求项目全流程实机运行
 *
 * 调用关系：维护者在 Server 仓库执行本脚本；脚本只读 MySQL 复核 Run、Inventory、Entry 和
 * Artifact 证据，`--apply` 模式再调用 Worker 内部技能目录 API、浏览器职业/风格 API。
 * 输入：本次已审计的职业 UUID、Inventory Run UUID、BOM 安全资源计划，以及进程环境中的
 * DATABASE_URL；写入模式另需 Worker token 与浏览器账号密码。输出：不含秘密和完整 Prompt 的
 * JSON 审计摘要。副作用：dry-run 没有业务写入；apply 会替换职业技能目录、创建或更新独立技术
 * 风格并送审，数据库业务表仍只由正式 Service/Repository 事务修改。
 * 安全边界：API 只允许回环地址；资源必须精确匹配 sourceId、源 NPK 长度/哈希、Entry 路径、
 * IMG 版本和元数据哈希；31/417/28 任一数量漂移、重复 Entry、缺帧清单、非 passed Run、四项
 * 安全声明非 false 或已有风格生产记录都会 fail-closed。Prompt 只声明技术组件和视觉约束，
 * 不声明中文技能映射、全技能覆盖、客户端兼容或部署授权。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { z } from "zod";
import {
  applyPreparation,
  buildStyle,
  payloadDigest,
} from "./prepare-profession-catalog-apply.mjs";
import { assert } from "./process.mjs";
const expectedComponentCount = 31;
const expectedSourceCount = 28;
const expectedSelectedEntryCount = 417;
const defaultProfessionId = "77e47a9c-d3fd-4f99-8cb4-c8a8149abcea",
  defaultSourceRunId = "3508f3e0-2477-4553-b2d4-1de59218d355",
  defaultStyleName = "维吉尔 31技术组件实机";
const defaultPlanPath = fileURLToPath(
  new URL(
    "../../../dnf-patch-worker/剑魂/Vergil（维吉尔）暗蓝幻影主题/configs/full-skill-v1/resource-plan-v3.json",
    import.meta.url,
  ),
);
const uuidSchema = z.uuid();
const sha256Schema = z.string().regex(/^[A-Fa-f0-9]{64}$/u);
const stableKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const sourceNpkSchema = z
  .object({
    length: z.number().int().positive(),
    sha256: sha256Schema,
  })
  .passthrough();
const planSourceSchema = z
  .object({
    id: stableKeySchema,
    sourceNpk: sourceNpkSchema,
    immutable: z.literal(true),
  })
  .passthrough();
const planComponentSchema = z
  .object({
    id: stableKeySchema,
    sourceId: stableKeySchema,
    imgVersion: z.enum(["Ver2", "Ver5"]),
    counts: z
      .object({ allowedImgCount: z.number().int().positive() })
      .passthrough(),
    selectedImgPaths: z.array(z.string().trim().min(1).max(500)).min(1),
    selectedForAggregation: z.literal(true),
  })
  .passthrough();
const resourcePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: stableKeySchema,
    scope: z
      .object({
        componentBuildCount: z.literal(expectedComponentCount),
        componentBuildPassedCount: z.literal(expectedComponentCount),
      })
      .passthrough(),
    sources: z.array(planSourceSchema).length(expectedSourceCount),
    components: z.array(planComponentSchema).length(expectedComponentCount),
  })
  .passthrough();
/** 解析固定参数；秘密只能来自环境变量，防止进入 PowerShell 历史和审计摘要。 */
function parseOptions(argv) {
  const options = {
    apply: false,
    catalogOnly: false,
    professionId: defaultProfessionId,
    sourceRunId: defaultSourceRunId,
    planPath: defaultPlanPath,
    styleName: defaultStyleName,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--catalog-only") {
      options.catalogOnly = true;
      continue;
    }
    const value = argv[index + 1];
    assert(value && !value.startsWith("--"), `${argument} 缺少参数值。`);
    if (argument === "--profession-id") options.professionId = value;
    else if (argument === "--source-run-id") options.sourceRunId = value;
    else if (argument === "--plan") options.planPath = value;
    else if (argument === "--style-name") options.styleName = value;
    else throw new Error(`不支持的参数：${argument}`);
    index += 1;
  }
  uuidSchema.parse(options.professionId);
  uuidSchema.parse(options.sourceRunId);
  assert(
    options.styleName.trim().length > 0 && options.styleName.length <= 160,
    "技术风格名称必须为 1..160 个字符。",
  );
  return options;
}

/** BOM 安全地读取资源事实计划；Zod 只提取本次连接所需字段，其他审计字段保持由原文件负责。 */
async function readResourcePlan(planPath) {
  const text = (await readFile(planPath, "utf8")).replace(/^\uFEFF/u, "");
  return resourcePlanSchema.parse(JSON.parse(text));
}

/** 规范化 NPK 内部相对路径；拒绝盘符、根路径和父目录，避免把本机路径误当资源身份。 */
function normalizeInternalPath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  assert(
    !normalized.startsWith("/") &&
      !/^[A-Za-z]:/u.test(normalized) &&
      !normalized.split("/").includes(".."),
    `资源计划包含非法内部路径：${value}`,
  );
  return normalized.toLowerCase();
}

/** 从数据库读取本次 Run 与全部 Inventory Entry；只执行 SELECT，不接触官方文件或业务写入。 */
async function readFrozenEvidence(database, sourceRunId, professionId) {
  const [runRows] = await database.execute(
    "SELECT runs.id, runs.project_id AS projectId, runs.snapshot_id AS snapshotId, runs.status, runs.deployment_authorized AS deploymentAuthorized, runs.deployment_performed AS deploymentPerformed, runs.full_skill_coverage_proven AS fullSkillCoverageProven, runs.client_compatibility_proven AS clientCompatibilityProven, professions.workflow_project_id AS professionProjectId FROM runs INNER JOIN professions ON professions.id = ? WHERE runs.id = ?",
    [professionId, sourceRunId],
  );
  assert(runRows.length === 1, "找不到唯一的 Inventory Run。 ");
  const [entryRows] = await database.execute(
    "SELECT inventories.id AS inventoryId, inventories.source_id AS sourceId, inventories.source_length AS sourceLength, inventories.source_sha256 AS sourceSha256, inventories.entry_count AS inventoryEntryCount, inventories.status AS inventoryStatus, inventories.source_frame_manifest_artifact_id AS sourceFrameManifestArtifactId, entries.id AS entryId, entries.internal_path AS internalPath, entries.img_version AS imgVersion, entries.frame_count AS frameCount, entries.metadata_sha256 AS metadataSha256 FROM npk_inventories AS inventories INNER JOIN npk_inventory_entries AS entries ON entries.inventory_id = inventories.id INNER JOIN artifacts ON artifacts.run_id = inventories.run_id AND artifacts.id = inventories.source_frame_manifest_artifact_id WHERE inventories.run_id = ? ORDER BY inventories.source_id, entries.internal_path",
    [sourceRunId],
  );
  return { run: runRows[0], entries: entryRows };
}

/** 验证 Run 终态与四项固定 false；这些条件通过不等于证明覆盖、兼容或部署。 */
function assertRunSafety(run) {
  assert(run.status === "passed", "资源事实 Run 不是 passed 终态。");
  assert(
    !run.professionProjectId || run.professionProjectId === run.projectId,
    "职业已绑定到其他工作流项目。 ",
  );
  for (const field of [
    "deploymentAuthorized",
    "deploymentPerformed",
    "fullSkillCoverageProven",
    "clientCompatibilityProven",
  ]) {
    assert(
      run[field] === 0 || run[field] === false,
      `${field} 必须保持 false。`,
    );
  }
}

/**
 * 以 sourceId 选择唯一 Inventory，再以内部路径选择唯一 Entry，构造服务端目录 DTO。
 * 任一零匹配、多匹配、版本漂移或跨组件重复 Entry 都会在 API 调用前中止。
 */
function buildCatalog(plan, evidence, sourceRunId) {
  assertRunSafety(evidence.run);
  const sourceIds = new Set(plan.sources.map((source) => source.id));
  assert(sourceIds.size === expectedSourceCount, "资源计划包含重复 sourceId。");
  const componentIds = new Set(
    plan.components.map((component) => component.id),
  );
  assert(
    componentIds.size === expectedComponentCount,
    "资源计划包含重复组件 ID。",
  );
  const selectedPathCount = plan.components.reduce(
    (total, component) => total + component.selectedImgPaths.length,
    0,
  );
  assert(
    selectedPathCount === expectedSelectedEntryCount,
    `资源计划必须精确选择 ${String(expectedSelectedEntryCount)} 条 IMG。`,
  );

  const sourcesById = new Map(
    plan.sources.map((source) => [source.id, source]),
  );
  const entriesBySource = new Map();
  for (const entry of evidence.entries) {
    const sourceEntries = entriesBySource.get(entry.sourceId) ?? [];
    sourceEntries.push(entry);
    entriesBySource.set(entry.sourceId, sourceEntries);
  }
  assert(
    entriesBySource.size === expectedSourceCount,
    `成功 Run 必须包含 ${String(expectedSourceCount)} 个有 Entry 的来源。`,
  );
  const usedEntryIds = new Set();
  let selectedFrameCount = 0;
  const skills = plan.components.map((component) => {
    const source = sourcesById.get(component.sourceId);
    assert(source, `组件 ${component.id} 引用了不存在的 sourceId。`);
    const sourceEntries = entriesBySource.get(component.sourceId) ?? [];
    assert(
      sourceEntries.length > 0,
      `组件 ${component.id} 的 Inventory 来源为空。`,
    );
    const inventoryIds = new Set(
      sourceEntries.map((entry) => entry.inventoryId),
    );
    assert(
      inventoryIds.size === 1,
      `sourceId ${component.sourceId} 未唯一对应 Inventory。`,
    );
    const inventory = sourceEntries[0];
    assert(
      inventory.inventoryStatus === "frozen",
      `sourceId ${component.sourceId} 的 Inventory 未冻结。`,
    );
    assert(
      inventory.sourceFrameManifestArtifactId,
      `sourceId ${component.sourceId} 缺少帧清单 Artifact。`,
    );
    assert(
      Number(inventory.sourceLength) === source.sourceNpk.length,
      `sourceId ${component.sourceId} 的源长度漂移。`,
    );
    assert(
      inventory.sourceSha256.toUpperCase() ===
        source.sourceNpk.sha256.toUpperCase(),
      `sourceId ${component.sourceId} 的源哈希漂移。`,
    );
    assert(
      component.selectedImgPaths.length === component.counts.allowedImgCount,
      `组件 ${component.id} 的 IMG 计数与计划不一致。`,
    );

    const rowsByPath = new Map(
      sourceEntries.map((entry) => [
        normalizeInternalPath(entry.internalPath),
        entry,
      ]),
    );
    const selectedEntries = component.selectedImgPaths.map((path) => {
      const entry = rowsByPath.get(normalizeInternalPath(path));
      assert(
        entry,
        `组件 ${component.id} 的 IMG 不存在于冻结 Inventory：${path}`,
      );
      assert(
        !usedEntryIds.has(entry.entryId),
        `Inventory Entry 被多个组件重复使用：${path}`,
      );
      assert(
        Number(entry.imgVersion) === Number(component.imgVersion.slice(3)),
        `组件 ${component.id} 的 IMG 版本漂移：${path}`,
      );
      assert(
        Number(entry.frameCount) > 0,
        `组件 ${component.id} 包含零帧 IMG：${path}`,
      );
      usedEntryIds.add(entry.entryId);
      selectedFrameCount += Number(entry.frameCount);
      return {
        sourceInventoryEntryId: uuidSchema.parse(entry.entryId),
        sourceMetadataSha256: sha256Schema
          .parse(entry.metadataSha256)
          .toUpperCase(),
      };
    });
    return {
      stableKey: component.id,
      displayName: `技术组件 ${component.id}`,
      promptStatus: "candidate",
      sourceScope: "selected-entries",
      sourceInventoryId: uuidSchema.parse(inventory.inventoryId),
      sourceEntries: selectedEntries,
      sourceFrameManifestArtifactId: uuidSchema.parse(
        inventory.sourceFrameManifestArtifactId,
      ),
      professionPrompt: buildProfessionPrompt(component.id),
    };
  });
  assert(
    usedEntryIds.size === expectedSelectedEntryCount,
    "417 条 Entry 未形成一一对应关系。",
  );
  return {
    payload: {
      workflowProjectId: uuidSchema.parse(evidence.run.projectId),
      catalogSnapshotId: uuidSchema.parse(evidence.run.snapshotId),
      sourceRunId,
      skills,
    },
    selectedFrameCount,
  };
}

/** 为一个技术组件生成职业阶段 Prompt；文本不包含中文技能名或覆盖性结论。 */
function buildProfessionPrompt(componentId) {
  return {
    schemaVersion: 1,
    stableSemantics: `资源身份仅为技术组件 ${componentId}；保持其冻结来源中的动作、时序、轮廓与层级语义，不推断中文技能名。`,
    commonPrompt:
      "只做维吉尔暗蓝幻影主题的视觉重制；保持原始构图、运动方向、帧间节奏和可读性。",
    sourceConstraints:
      "严格保持每帧宽高、Canvas、偏移、alpha、Hidden、LINK、共享纹理关系与帧顺序；不得新增、删除、重排或合并帧。",
    stageAcceptance:
      "逐 Entry 与冻结帧清单一致，几何和结构不变量全部通过，视觉变化仅限经审核的颜色、材质和粒子表达。",
  };
}

const options = parseOptions(process.argv.slice(2));
assert(
  process.env.DATABASE_URL,
  "缺少 DATABASE_URL；脚本不会从文件读取或输出数据库凭据。 ",
);
const plan = await readResourcePlan(options.planPath);
const database = await mysql.createConnection(process.env.DATABASE_URL);
try {
  const evidence = await readFrozenEvidence(
    database,
    options.sourceRunId,
    options.professionId,
  );
  const catalog = buildCatalog(plan, evidence, options.sourceRunId);
  const dryRunStyle = buildStyle(
    options.styleName,
    catalog.payload.skills.map((skill, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      stableKey: skill.stableKey,
    })),
  );
  const applied =
    options.apply || options.catalogOnly
      ? await applyPreparation(database, options, catalog.payload)
      : undefined;
  console.log(
    JSON.stringify(
      {
        mode: options.catalogOnly
          ? "catalog-only"
          : options.apply
            ? "apply"
            : "dry-run",
        professionId: options.professionId,
        sourceRunId: options.sourceRunId,
        projectId: catalog.payload.workflowProjectId,
        snapshotId: catalog.payload.catalogSnapshotId,
        resourcePlan: {
          planId: plan.planId,
          sourceCount: plan.sources.length,
          componentCount: plan.components.length,
          selectedEntryCount: catalog.payload.skills.reduce(
            (total, skill) => total + skill.sourceEntries.length,
            0,
          ),
          selectedFrameCount: catalog.selectedFrameCount,
        },
        safety: {
          deploymentAuthorized: false,
          deploymentPerformed: false,
          fullSkillCoverageProven: false,
          clientCompatibilityProven: false,
        },
        catalogPayload: payloadDigest(catalog.payload),
        styleDraft: payloadDigest(dryRunStyle),
        ...(applied ? { applied } : {}),
      },
      null,
      2,
    ),
  );
} finally {
  await database.end();
}
