/**
 * @fileoverview 执行职业技术目录与风格的正式 API 写入，并在数据库中复核写后事实；
 * 不读取资源计划、官方 NPK 或模型密钥，也不创建制作任务。
 * @module scripts/runtime-test
 * @author AI生成
 * @created 2026-07-27
 * @relatedPlan N/A - 用户直接要求项目全流程实机运行
 *
 * 调用关系：prepare-profession-catalog 构造并核验 31/417 目录 DTO 后调用本模块；
 * `catalog-only` 只走 Worker 内部目录 API，完整 apply 再走浏览器登录、风格保存与送审 API。
 * 输入是已核验目录 DTO、职业 UUID、模式和进程环境中的短命凭据；输出仅含数量、ID、状态与摘要。
 * 副作用：正式 Service/Repository 事务会绑定职业 Project/Snapshot、降级保留旧候选、写入 31 个
 * 技术组件与 417 条来源；完整 apply 还会创建或更新独立风格并送审。
 * 失败路径：缺凭据、非回环 API、响应状态漂移、已有生产记录、数量/状态/来源写后不一致均停止。
 * 安全边界：不直接更新业务表，不输出密码/token/Prompt 正文，不创建 Job，不部署或写 ImagePacks2。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { assert } from "./process.mjs";

const expectedComponentCount = 31;
const expectedSelectedEntryCount = 417;
const promptPackageMaxBytes = 48 * 1_024;
const uuidSchema = z.uuid();

/** 使用服务端返回的稳定技能 UUID 构造独立技术风格 DTO。 */
export function buildStyle(styleName, catalogSkills) {
  const selectedSkillIds = catalogSkills.map((skill) =>
    uuidSchema.parse(skill.id),
  );
  const skillPrompts = catalogSkills.map((skill) => ({
    skillId: uuidSchema.parse(skill.id),
    themePrompt: `将技术组件 ${skill.stableKey} 转换为维吉尔暗蓝幻影主题，保持来源动作、轮廓与时序。`,
    changes:
      "使用冰蓝外缘、白色刃核、青色裂纹和暗蓝辉光；仅加入稀疏、沿原运动方向分布的粒子。",
    acceptanceCriteria:
      "结构与冻结来源完全一致；主体在连续帧中清晰，颜色层次稳定，粒子不遮挡关键轮廓。",
    exclusions:
      "不得改变几何、Canvas、偏移、alpha、Hidden、LINK、共享纹理或帧序；不得声明覆盖、兼容或部署。",
  }));
  const style = {
    name: styleName,
    description:
      "面向 31 个已核验技术组件的实机生产候选；与既有中文候选 Prompt 分层保存，不声明中文全技能覆盖。",
    themeDefinition: {
      schemaVersion: 1,
      goal: "以维吉尔暗蓝幻影视觉统一已核验技术组件，同时保持来源动作语义和运行时结构。",
      baseStyle:
        "冷峻、锐利、低噪声的高速剑术效果；主体边缘清楚，爆发帧保持原始视觉重心。",
      colorAnchors: [
        { name: "暗蓝辉光", value: "#123B73" },
        { name: "冰蓝外缘", value: "#55C7F3" },
        { name: "白色刃核", value: "#F5FBFF" },
        { name: "青色裂纹", value: "#27E0D2" },
      ],
      materialRules:
        "高能刃核接近白色，向外依次过渡为冰蓝和暗蓝；保留原 alpha 层次，不制造不透明色块。",
      particleRules:
        "粒子数量稀疏，沿原始运动方向分布；不得扩张画布、遮挡主体或改变帧间运动节奏。",
      layeringRules:
        "遵循原始 IMG、帧和共享纹理层级；只改变像素视觉，不改变 Hidden、LINK 与绘制顺序。",
      constraints:
        "逐帧保持宽高、Canvas、偏移、alpha、共享关系和帧序；只处理冻结 Entry，不触及官方 NPK。",
      acceptanceCriteria:
        "31 个技术组件逐项通过冻结来源、几何、结构、模型阶段和独立验证器门禁。",
      exclusions:
        "不推断中文技能映射，不证明全技能覆盖或客户端兼容，不授权部署，不写入 ImagePacks2。",
    },
    selectedSkillIds,
    skillPrompts,
  };
  assert(
    Buffer.byteLength(JSON.stringify(style), "utf8") <= promptPackageMaxBytes,
    "技术风格 Prompt 包超过 48 KiB。 ",
  );
  return style;
}

/** 对 DTO 计算本次序列化摘要；用于审计输出，不替代服务端 JCS 哈希。 */
export function payloadDigest(payload) {
  const serialized = JSON.stringify(payload);
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256")
      .update(serialized, "utf8")
      .digest("hex")
      .toUpperCase(),
  };
}

/** 只访问回环 Server；失败仅保留状态码与稳定错误码，避免响应正文进入日志。 */
async function requestApi(baseUrl, path, options, expectedStatuses) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${options.method ?? "GET"} ${path} 返回非 JSON 响应。`);
  }
  if (!expectedStatuses.includes(response.status)) {
    const code = payload?.error?.code ?? payload?.code ?? "UNKNOWN_API_ERROR";
    throw new Error(
      `${options.method ?? "GET"} ${path} 返回 ${String(response.status)} (${String(code)})。`,
    );
  }
  return payload;
}

/** 验证回环 API 与当前模式所需凭据；秘密只从进程环境读取且不进入返回摘要。 */
function readApplyEnvironment(catalogOnly) {
  const baseUrl =
    process.env.PREPARE_SERVER_BASE_URL ?? "http://127.0.0.1:56789/v1";
  const url = new URL(baseUrl);
  assert(
    url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname),
    "准备脚本只允许访问 HTTP 回环 Server。 ",
  );
  assert(
    url.pathname.replace(/\/$/u, "") === "/v1",
    "Server API 基址必须以 /v1 结尾。 ",
  );
  const workerToken =
    process.env.PREPARE_WORKER_TOKEN ?? process.env.WORKER_SHARED_TOKEN;
  const username = process.env.PREPARE_BROWSER_USERNAME;
  const password = process.env.PREPARE_BROWSER_PASSWORD;
  assert(
    workerToken,
    "写入目录需要 PREPARE_WORKER_TOKEN 或 WORKER_SHARED_TOKEN。 ",
  );
  assert(
    catalogOnly || (username && password),
    "完整 apply 需要 PREPARE_BROWSER_USERNAME 和 PREPARE_BROWSER_PASSWORD。 ",
  );
  return {
    baseUrl: baseUrl.replace(/\/$/u, ""),
    workerToken,
    username,
    password,
  };
}

/**
 * 通过正式 API 写入目录；完整模式再保存风格并送审。
 * 目录写入前记录非技术技能基线，写后要求它们数量不变并全部保持 draft-only。
 */
export async function applyPreparation(database, options, catalogPayload) {
  const environment = readApplyEnvironment(options.catalogOnly);
  const technicalKeys = new Set(
    catalogPayload.skills.map((skill) => skill.stableKey),
  );
  const [skillsBefore] = await database.execute(
    "SELECT stable_key AS stableKey FROM profession_skills WHERE profession_id = ?",
    [options.professionId],
  );
  const legacySkillCount = skillsBefore.filter(
    (skill) => !technicalKeys.has(skill.stableKey),
  ).length;
  const imported = await requestApi(
    environment.baseUrl,
    `/internal/professions/${options.professionId}/skill-catalog`,
    {
      method: "PUT",
      headers: { "X-Worker-Token": environment.workerToken },
      body: catalogPayload,
    },
    [200],
  );
  assert(
    imported.importedSkillCount === expectedComponentCount,
    "目录 API 未导入 31 个组件。 ",
  );
  const [skillsAfter] = await database.execute(
    "SELECT id, stable_key AS stableKey, execution_status AS executionStatus FROM profession_skills WHERE profession_id = ?",
    [options.professionId],
  );
  const technicalSkills = skillsAfter
    .filter((skill) => technicalKeys.has(skill.stableKey))
    .sort(
      (left, right) =>
        catalogPayload.skills.findIndex(
          (item) => item.stableKey === left.stableKey,
        ) -
        catalogPayload.skills.findIndex(
          (item) => item.stableKey === right.stableKey,
        ),
    );
  assert(
    technicalSkills.length === expectedComponentCount,
    "写入后数据库缺少技术组件。 ",
  );
  const catalogWrite = await verifyCatalogWrite(
    database,
    options,
    catalogPayload,
    skillsAfter,
    legacySkillCount,
  );
  if (options.catalogOnly) {
    return catalogWrite;
  }
  return applyStyle(
    database,
    options,
    catalogPayload,
    technicalSkills,
    environment,
    catalogWrite,
  );
}

/** 使用目标浏览器账号创建/更新风格；已有生产记录的同名风格禁止修改。 */
async function applyStyle(
  database,
  options,
  catalogPayload,
  technicalSkills,
  environment,
  catalogWrite,
) {
  const login = await requestApi(
    environment.baseUrl,
    "/auth/login",
    {
      method: "POST",
      body: { username: environment.username, password: environment.password },
    },
    [200, 201],
  );
  const accessToken = login?.data?.accessToken;
  assert(
    typeof accessToken === "string" && accessToken.length > 0,
    "浏览器登录未返回 access token。 ",
  );
  const browserHeaders = { Authorization: `Bearer ${accessToken}` };
  const stylesBefore = await requestApi(
    environment.baseUrl,
    `/professions/${options.professionId}/styles`,
    { headers: browserHeaders },
    [200],
  );
  const matches = stylesBefore.data.filter(
    (style) => style.name === options.styleName,
  );
  assert(matches.length <= 1, "技术风格名称对应多条记录。 ");
  if (matches[0]) {
    const [productionRows] = await database.execute(
      "SELECT COUNT(*) AS productionCount FROM style_skill_productions WHERE style_id = ?",
      [matches[0].id],
    );
    assert(
      Number(productionRows[0].productionCount) === 0,
      "技术风格已有生产记录，拒绝修改。 ",
    );
  }
  const styleInput = buildStyle(options.styleName, technicalSkills);
  const saved = matches[0]
    ? await requestApi(
        environment.baseUrl,
        `/professions/${options.professionId}/styles/${matches[0].id}`,
        { method: "PUT", headers: browserHeaders, body: styleInput },
        [200],
      )
    : await requestApi(
        environment.baseUrl,
        `/professions/${options.professionId}/styles`,
        { method: "POST", headers: browserHeaders, body: styleInput },
        [200, 201],
      );
  let style = saved.data;
  if (!["pending", "published"].includes(style.publishStatus)) {
    const reviewed = await requestApi(
      environment.baseUrl,
      `/professions/${options.professionId}/styles/${style.id}/review`,
      { method: "POST", headers: browserHeaders },
      [200, 201],
    );
    style = reviewed.data;
  }
  return {
    styleId: style.id,
    stylePublishStatus: style.publishStatus,
    stylePrompt: payloadDigest(styleInput),
    ...catalogWrite,
  };
}

/** 写后复核技术组件、旧候选层与来源总数；API 成功响应不替代数据库事实。 */
async function verifyCatalogWrite(
  database,
  options,
  catalogPayload,
  skillsAfter,
  expectedLegacySkillCount,
) {
  const technicalKeys = new Set(
    catalogPayload.skills.map((skill) => skill.stableKey),
  );
  const importedAfter = skillsAfter.filter((skill) =>
    technicalKeys.has(skill.stableKey),
  );
  const legacyAfter = skillsAfter.filter(
    (skill) => !technicalKeys.has(skill.stableKey),
  );
  assert(
    importedAfter.length === expectedComponentCount,
    "写入后技术组件数量不是 31。 ",
  );
  assert(
    importedAfter.every((skill) => skill.executionStatus === "build-ready"),
    "写入后存在非 build-ready 技术组件。 ",
  );
  assert(
    legacyAfter.length === expectedLegacySkillCount,
    "旧候选技能数量未保持写前基线。 ",
  );
  assert(
    legacyAfter.every((skill) => skill.executionStatus === "draft-only"),
    "旧候选技能未全部保持 draft-only。 ",
  );
  const [sourceRows] = await database.execute(
    "SELECT COUNT(*) AS sourceEntryCount FROM profession_skill_source_entries WHERE profession_id = ?",
    [options.professionId],
  );
  assert(
    Number(sourceRows[0].sourceEntryCount) === expectedSelectedEntryCount,
    "写入后的技能来源不是 417 条。 ",
  );
  return {
    buildReadySkillCount: importedAfter.length,
    legacyDraftOnlySkillCount: legacyAfter.length,
    sourceEntryCount: Number(sourceRows[0].sourceEntryCount),
  };
}
