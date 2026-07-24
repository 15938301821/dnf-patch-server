/**
 * @fileoverview 为 Profession 单技能输出接收测试构造冻结 Job、模型执行、来源与上传会话行；
 * 不连接 MySQL、不读取对象正文，也不作为生产代码或线协议使用。
 * @module modules/job/patch-task-skill-production-repository-fixture
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：相邻 Vitest 行为测试按具名场景创建最小 Drizzle transaction stub，再调用真实接收函数。
 * 输入是有限场景名，输出包含 passed DTO、数据库端口和写入观察值。副作用仅记录 mock 调用。
 * 安全边界：fixture 不证明真实 CHECK、复合外键或 row lock；场景必须保留当前 attempt、固定来源、
 * 双模型阶段和双 finalized upload 的完整证据，不得用永远成功的 stub 绕过被测校验。
 */
import { vi } from "vitest";
import type { DatabaseService } from "../../common/db/database.service.js";
import { sha256JcsV1, sha256Json } from "../../common/utils/canonical.js";
import type { ReportPatchTaskSkillProductionInput } from "./patch-task.contracts.js";
import {
  createStyleSkillPromptComposition,
  type StyleSkillProductionJobPayloadV2,
} from "./style-skill-production.contracts.js";

/** 行为断言使用的稳定 UUID 与数据库时间；这些值只存在于测试，不代表真实生产证据。 */
export const skillProductionFixture = {
  jobId: "00000000-0000-4000-8000-000000000000",
  workerId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  professionId: "44444444-4444-4444-8444-444444444444",
  styleId: "55555555-5555-4555-8555-555555555555",
  skillId: "66666666-6666-4666-8666-666666666666",
  sourceRunId: "77777777-7777-4777-8777-777777777777",
  sourceInventoryId: "88888888-8888-4888-8888-888888888888",
  sourceManifestArtifactId: "99999999-9999-4999-8999-999999999999",
  engineerModelCallId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  artistModelCallId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  engineerArtifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  referenceArtifactId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  imageAttemptId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  projectsArtifactId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  validationArtifactId: "10101010-1010-4010-8010-101010101010",
  projectsUploadId: "20202020-2020-4020-8020-202020202020",
  validationUploadId: "30303030-3030-4030-8030-303030303030",
  now: new Date("2026-07-24T00:00:00.000Z"),
} as const;

type PassedReport = Extract<
  ReportPatchTaskSkillProductionInput,
  { status: "passed" }
>;

/** 接收事务测试允许改变的单一失败条件，其他证据保持有效以隔离被测分支。 */
export type SkillProductionReportScenario =
  | "accepted"
  | "old-attempt"
  | "artist-old-attempt"
  | "projects-not-finalized"
  | "validation-projects-role";

/** 测试可观察的数据库端口、passed 输入和写入记录。 */
export interface SkillProductionReportHarness {
  connection: DatabaseService;
  input: PassedReport;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  forUpdate: (lock: string) => void;
  updated: Record<string, unknown>[];
}

/**
 * 创建一个只改变单项证据的接收事务场景。
 * @param scenario accepted 或一个精确失败条件；未指定时构造完整当前-attempt 证据。
 * @returns 可传给真实接收函数的数据库端口、DTO 和 mock 观察器。
 */
export function createSkillProductionReportHarness(
  scenario: SkillProductionReportScenario = "accepted",
): SkillProductionReportHarness {
  const payload = validPayload();
  const input: PassedReport = {
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: scenario === "old-attempt" ? 1 : 2,
    skillId: skillProductionFixture.skillId,
    status: "passed",
    asepriteBinarySha256: "1".repeat(64),
    asepriteAdapterSha256: "2".repeat(64),
    asepriteArtifactId: skillProductionFixture.projectsArtifactId,
    validationArtifactId: skillProductionFixture.validationArtifactId,
  };
  const rows =
    scenario === "old-attempt"
      ? [[leasedJob(payload)], [{ value: skillProductionFixture.now }]]
      : acceptedRows(payload, scenario);
  return reportHarness(rows, input);
}

function acceptedRows(
  payload: StyleSkillProductionJobPayloadV2,
  scenario: SkillProductionReportScenario,
): unknown[][] {
  const artist = artistExecution(payload);
  if (scenario === "artist-old-attempt") artist.attempt = 1;
  const projects = projectsUploadRow();
  if (scenario === "projects-not-finalized") {
    projects.sessionStatus = "authorized";
  }
  const validation = validationUploadRow();
  if (scenario === "validation-projects-role") {
    validation.sessionProvenance = projectsProvenance();
    validation.artifactProvenance = projectsProvenance();
  }
  return [
    [leasedJob(payload)],
    [{ value: skillProductionFixture.now }],
    [production(payload)],
    [engineerExecution(payload)],
    [artist],
    [sourceEvidenceRow()],
    [projects],
    [validation],
  ];
}

function leasedJob(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  return {
    id: skillProductionFixture.jobId,
    runId: skillProductionFixture.runId,
    kind: "profession",
    status: "leased",
    leaseOwnerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    leaseExpiresAt: new Date("2026-07-24T00:01:00.000Z"),
    attemptCount: 2,
    payload,
    payloadSha256: sha256Json(payload),
  };
}

function production(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  const skill = requiredSkill(payload);
  return {
    id: "40404040-4040-4040-8040-404040404040",
    professionId: skillProductionFixture.professionId,
    styleId: skillProductionFixture.styleId,
    skillId: skillProductionFixture.skillId,
    runId: skillProductionFixture.runId,
    jobId: null,
    sourceRunId: skillProductionFixture.sourceRunId,
    sourceFrameManifestArtifactId:
      skillProductionFixture.sourceManifestArtifactId,
    promptSha256: skill.promptSha256,
    status: "validating",
  };
}

function engineerExecution(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  return modelExecution(payload, {
    id: "50505050-5050-4050-8050-505050505050",
    stage: "engineer-plan-v1",
    modelCallId: skillProductionFixture.engineerModelCallId,
    imageAttemptId: null,
    outputArtifactId: skillProductionFixture.engineerArtifactId,
    outputSha256: "E".repeat(64),
  });
}

function artistExecution(
  payload: StyleSkillProductionJobPayloadV2,
): Record<string, unknown> {
  return modelExecution(payload, {
    id: "60606060-6060-4060-8060-606060606060",
    stage: "reference-image-v1",
    modelCallId: skillProductionFixture.artistModelCallId,
    imageAttemptId: skillProductionFixture.imageAttemptId,
    outputArtifactId: skillProductionFixture.referenceArtifactId,
    outputSha256: "F".repeat(64),
  });
}

function modelExecution(
  payload: StyleSkillProductionJobPayloadV2,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return {
    runId: skillProductionFixture.runId,
    jobId: skillProductionFixture.jobId,
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: 2,
    skillId: skillProductionFixture.skillId,
    promptSha256: requiredSkill(payload).promptSha256,
    status: "passed",
    outputByteLength: 128,
    errorCode: null,
    ...evidence,
  };
}

function sourceEvidenceRow(): Record<string, unknown> {
  return {
    runId: skillProductionFixture.sourceRunId,
    inventoryId: skillProductionFixture.sourceInventoryId,
    sourceSha256: "A".repeat(64),
    manifestArtifactId: skillProductionFixture.sourceManifestArtifactId,
    manifestLogicalName: "source-frame-manifest.json",
    manifestMediaType: "application/json",
    manifestSha256: "B".repeat(64),
    manifestProvenance: {
      schemaVersion: 1,
      kind: "source-frame-manifest",
      sourceSha256: "A".repeat(64),
      toolSha256: "C".repeat(64),
      jobPayloadSha256: "D".repeat(64),
      deploymentAuthorized: false,
    },
  };
}

function projectsUploadRow(): Record<string, unknown> {
  return uploadRow(
    skillProductionFixture.projectsUploadId,
    skillProductionFixture.projectsArtifactId,
    "projects.zip",
    "3".repeat(64),
    projectsProvenance(),
  );
}

function validationUploadRow(): Record<string, unknown> {
  return uploadRow(
    skillProductionFixture.validationUploadId,
    skillProductionFixture.validationArtifactId,
    "validation.zip",
    "4".repeat(64),
    validationProvenance(),
  );
}

function uploadRow(
  uploadId: string,
  artifactId: string,
  logicalName: string,
  sha256: string,
  provenance: Record<string, unknown>,
): Record<string, unknown> {
  const objectKey = `artifacts/${artifactId}.zip`;
  return {
    uploadId,
    sessionRunId: skillProductionFixture.runId,
    sessionJobId: skillProductionFixture.jobId,
    workerId: skillProductionFixture.workerId,
    leaseId: skillProductionFixture.leaseId,
    attempt: 2,
    objectKey,
    sessionLogicalName: logicalName,
    sessionMediaType: "application/zip",
    expectedByteLength: 256,
    expectedSha256: sha256,
    sessionProvenance: provenance,
    sessionStatus: "finalized",
    sessionArtifactId: artifactId,
    finalizedAt: skillProductionFixture.now,
    objectDeletedAt: null,
    artifactId,
    artifactRunId: skillProductionFixture.runId,
    storageKey: objectKey,
    artifactLogicalName: logicalName,
    artifactMediaType: "application/zip",
    artifactByteLength: 256,
    artifactSha256: sha256,
    artifactProvenance: provenance,
  };
}

function projectsProvenance(): Record<string, unknown> {
  return {
    ...baseOutputProvenance(),
    kind: "profession-aseprite-projects-v1",
  };
}

function validationProvenance(): Record<string, unknown> {
  return {
    ...baseOutputProvenance(),
    kind: "profession-aseprite-validation-v1",
    asepriteProjects: {
      artifactId: skillProductionFixture.projectsArtifactId,
      sha256: "3".repeat(64),
    },
  };
}

function baseOutputProvenance(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    jobId: skillProductionFixture.jobId,
    attempt: 2,
    skillId: skillProductionFixture.skillId,
    source: {
      runId: skillProductionFixture.sourceRunId,
      inventoryId: skillProductionFixture.sourceInventoryId,
      sourceSha256: "A".repeat(64),
      frameManifestArtifactId: skillProductionFixture.sourceManifestArtifactId,
      frameManifestSha256: "B".repeat(64),
      frameManifestToolSha256: "C".repeat(64),
    },
    engineerPlan: {
      artifactId: skillProductionFixture.engineerArtifactId,
      sha256: "E".repeat(64),
    },
    referenceImage: {
      imageAttemptId: skillProductionFixture.imageAttemptId,
      artifactId: skillProductionFixture.referenceArtifactId,
      sha256: "F".repeat(64),
    },
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: "1".repeat(64),
      adapterSha256: "2".repeat(64),
    },
    safety: {
      referenceImageUsedForRuntimePixels: false,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
}

function reportHarness(
  selectRows: unknown[][],
  input: PassedReport,
): SkillProductionReportHarness {
  let selectIndex = 0;
  const forUpdateMock = vi.fn();
  const recordForUpdate = (lock: string): void => {
    forUpdateMock(lock);
  };
  const select = vi.fn(() => {
    const rows = selectRows[selectIndex] ?? [];
    selectIndex += 1;
    return { from: vi.fn(() => queryBuilder(rows, recordForUpdate)) };
  });
  const updated: Record<string, unknown>[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((value: Record<string, unknown>) => ({
      where: vi.fn(() => {
        updated.push(value);
        return Promise.resolve([{ affectedRows: 1 }]);
      }),
    })),
  }));
  const transaction = vi.fn(
    (
      callback: (transaction: {
        select: typeof select;
        update: typeof update;
      }) => unknown,
    ) => Promise.resolve(callback({ select, update })),
  );
  return {
    connection: {
      database: { transaction },
    } as unknown as DatabaseService,
    input,
    select,
    update,
    forUpdate: forUpdateMock,
    updated,
  };
}

function queryBuilder(
  rows: unknown[],
  recordForUpdate: (lock: string) => void,
): Record<string, unknown> {
  const query = {
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => query),
    for: vi.fn((lock: string) => {
      recordForUpdate(lock);
      return Promise.resolve(rows);
    }),
    then: (resolve: (value: unknown[]) => unknown): Promise<unknown> =>
      Promise.resolve(rows).then(resolve),
  };
  return query;
}

function requiredSkill(
  payload: StyleSkillProductionJobPayloadV2,
): StyleSkillProductionJobPayloadV2["parameters"]["promptPackage"]["skills"][number] {
  const skill = payload.parameters.promptPackage.skills[0];
  if (!skill) throw new Error("TEST_SKILL_REQUIRED");
  return skill;
}

function validPayload(): StyleSkillProductionJobPayloadV2 {
  const themeDefinition = {
    schemaVersion: 1 as const,
    goal: "统一暗蓝剑气主题",
    baseStyle: "深钴蓝剑气",
    colorAnchors: [{ name: "主色", value: "#123456" }],
    materialRules: "保留清晰边缘",
    particleRules: "保持粒子节奏",
    layeringRules: "不改变层级",
    constraints: "保持源几何",
    acceptanceCriteria: "逐帧轮廓可辨识",
    exclusions: "不新增角色效果",
  };
  const professionPrompt = {
    schemaVersion: 1 as const,
    stableSemantics: "保留技能身份",
    commonPrompt: "保持角色与武器轮廓",
    sourceConstraints: "只处理核验帧",
    stageAcceptance: "逐帧通过来源约束",
  };
  const skillThemePrompt = {
    skillId: skillProductionFixture.skillId,
    themePrompt: "暗蓝月牙剑气",
    changes: "替换剑气材质",
    acceptanceCriteria: "时间轴一致",
    exclusions: "不修改命中范围",
  };
  const professionPromptSha256 = sha256JcsV1(professionPrompt);
  const skill = {
    skillId: skillProductionFixture.skillId,
    professionPrompt,
    professionPromptSha256,
    skillThemePrompt,
    promptSha256: sha256JcsV1(
      createStyleSkillPromptComposition(themeDefinition, {
        professionPrompt,
        professionPromptSha256,
        skillThemePrompt,
      }),
    ),
    sourceEvidence: {
      sourceRunId: skillProductionFixture.sourceRunId,
      sourceInventoryId: skillProductionFixture.sourceInventoryId,
      sourceFrameManifestArtifactId:
        skillProductionFixture.sourceManifestArtifactId,
      sourceEntries: [
        {
          sourceInventoryEntryId: "70707070-7070-4070-8070-707070707070",
          sourceMetadataSha256: "A".repeat(64),
        },
      ],
    },
  };
  const promptPackage = {
    schemaVersion: 2 as const,
    themeDefinition,
    skills: [skill],
  };
  return {
    schemaVersion: 1,
    profileId: "aseprite-production-v1",
    parameters: {
      workflow: "style-skill-production-v2",
      professionId: skillProductionFixture.professionId,
      styleId: skillProductionFixture.styleId,
      selectedSkillIds: [skillProductionFixture.skillId],
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  };
}
