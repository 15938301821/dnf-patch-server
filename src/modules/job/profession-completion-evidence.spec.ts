/**
 * @fileoverview 验证 Profession 多技能进度恢复与最终摘要纯规则；不连接 MySQL、不取得行锁，
 * 不调用 Worker、模型、对象存储或 Aseprite。
 * @module modules/job/profession-completion-evidence-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession Worker 纵向闭环直接需求
 *
 * Mock 边界：fixture 代替 Repository 已读取的 Job、production 和 Artifact 行，只证明纯解析规则；
 * 真实事务锁、外键、对象 finalize 与数据库时间仍需 Repository/MySQL 验证。
 */
import { describe, expect, it } from "vitest";
import { sha256JcsV1, sha256Json } from "../../common/utils/canonical.js";
import {
  resolveProfessionCompletionEvidence,
  type ProfessionCompletionArtifactRow,
  type ProfessionCompletionJobState,
  type ProfessionProductionEvidenceRow,
} from "./profession-completion-evidence.js";
import {
  createStyleSkillPromptComposition,
  type StyleSkillProductionJobPayloadV2,
} from "./style-skill-production.contracts.js";

const jobId = uuid(1);
const runId = uuid(2);
const professionId = uuid(3);
const styleId = uuid(4);
const workerId = uuid(5);
const skillIds = [uuid(10), uuid(20)] as const;

describe("resolveProfessionCompletionEvidence", () => {
  it("returns frozen order without a result while any skill is pending", () => {
    const fixture = evidenceFixture();
    fixture.productions[1] = {
      ...requireRow(fixture.productions[1]),
      status: "validating",
      jobId: null,
      workerId: null,
      leaseId: null,
      attempt: null,
      modelCallId: null,
      imageAttemptId: null,
      asepriteProfileId: null,
      asepriteBinarySha256: null,
      asepriteAdapterSha256: null,
      asepriteArtifactId: null,
      validationArtifactId: null,
    };

    expect(
      resolveProfessionCompletionEvidence(
        fixture.job,
        [...fixture.productions].reverse(),
        fixture.artifacts,
      ),
    ).toEqual({
      status: "accepted",
      progress: {
        schemaVersion: 1,
        skills: [
          { skillId: skillIds[0], status: "passed" },
          { skillId: skillIds[1], status: "pending" },
        ],
      },
    });
  });

  it("combines passed skills from different attempts into one stable result", () => {
    const fixture = evidenceFixture();
    const first = resolveProfessionCompletionEvidence(
      fixture.job,
      fixture.productions,
      fixture.artifacts,
    );
    const reordered = resolveProfessionCompletionEvidence(
      fixture.job,
      [...fixture.productions].reverse(),
      [...fixture.artifacts].reverse(),
    );

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      status: "accepted",
      progress: {
        skills: [
          { skillId: skillIds[0], status: "passed" },
          { skillId: skillIds[1], status: "passed" },
        ],
      },
    });
    if (first.status !== "accepted") throw new Error("TEST_RESULT_REQUIRED");
    expect(first.progress.resultSha256).toMatch(/^[A-F0-9]{64}$/u);
    expect(fixture.productions.map((row) => row.attempt)).toEqual([1, 2]);
  });

  it("rejects a production whose frozen Prompt identity drifted", () => {
    const fixture = evidenceFixture();
    fixture.productions[0] = {
      ...requireRow(fixture.productions[0]),
      promptSha256: "F".repeat(64),
    };

    expect(
      resolveProfessionCompletionEvidence(
        fixture.job,
        fixture.productions,
        fixture.artifacts,
      ),
    ).toEqual({ status: "production-integrity-failed" });
  });

  it("rejects two passed roles that reuse one Artifact", () => {
    const fixture = evidenceFixture();
    fixture.productions[1] = {
      ...requireRow(fixture.productions[1]),
      asepriteArtifactId: requireRow(fixture.productions[0]).asepriteArtifactId,
    };

    expect(
      resolveProfessionCompletionEvidence(
        fixture.job,
        fixture.productions,
        fixture.artifacts,
      ),
    ).toEqual({ status: "production-integrity-failed" });
  });

  it("rejects a finalized Artifact from another Run", () => {
    const fixture = evidenceFixture();
    fixture.artifacts[0] = {
      ...requireArtifact(fixture.artifacts[0]),
      runId: uuid(99),
    };

    expect(
      resolveProfessionCompletionEvidence(
        fixture.job,
        fixture.productions,
        fixture.artifacts,
      ),
    ).toEqual({ status: "production-integrity-failed" });
  });

  it("rejects a Job payload hash drift before exposing progress", () => {
    const fixture = evidenceFixture();

    expect(
      resolveProfessionCompletionEvidence(
        { ...fixture.job, payloadSha256: "0".repeat(64) },
        fixture.productions,
        fixture.artifacts,
      ),
    ).toEqual({ status: "job-integrity-failed" });
  });
});

function evidenceFixture(): {
  job: ProfessionCompletionJobState;
  productions: ProfessionProductionEvidenceRow[];
  artifacts: ProfessionCompletionArtifactRow[];
} {
  const payload = validPayload();
  const productions = payload.parameters.promptPackage.skills.map(
    (skill, index): ProfessionProductionEvidenceRow => ({
      runId,
      professionId,
      styleId,
      skillId: skill.skillId,
      jobId,
      workerId,
      leaseId: uuid(30 + index),
      attempt: index + 1,
      sourceRunId: skill.sourceEvidence.sourceRunId,
      sourceFrameManifestArtifactId:
        skill.sourceEvidence.sourceFrameManifestArtifactId,
      promptSha256: skill.promptSha256,
      modelCallId: uuid(40 + index),
      imageAttemptId: uuid(50 + index),
      asepriteProfileId: "aseprite-cli",
      asepriteBinarySha256: "A".repeat(64),
      asepriteAdapterSha256: "B".repeat(64),
      asepriteArtifactId: uuid(60 + index * 2),
      validationArtifactId: uuid(61 + index * 2),
      status: "passed",
      errorCode: null,
    }),
  );
  const artifacts = productions.flatMap((production, index) => [
    {
      id: requireId(production.asepriteArtifactId),
      runId,
      sha256: String(index + 1).repeat(64),
    },
    {
      id: requireId(production.validationArtifactId),
      runId,
      sha256: String(index + 3).repeat(64),
    },
  ]);
  return {
    job: {
      id: jobId,
      runId,
      kind: "profession",
      payload,
      payloadSha256: sha256Json(payload),
    },
    productions,
    artifacts,
  };
}

function validPayload(): StyleSkillProductionJobPayloadV2 {
  const themeDefinition = {
    schemaVersion: 1 as const,
    goal: "冻结主题",
    baseStyle: "pixel effect",
    colorAnchors: [{ name: "主色", value: "#123456" }],
    materialRules: "保持边缘",
    particleRules: "保持节奏",
    layeringRules: "保持层级",
    constraints: "保持几何",
    acceptanceCriteria: "逐帧可辨",
    exclusions: "不改变角色",
  };
  const skills = skillIds.map((skillId, index) => {
    const professionPrompt = {
      schemaVersion: 1 as const,
      stableSemantics: "保留技能身份",
      commonPrompt: `技能 ${String(index + 1)}`,
      sourceConstraints: "仅用冻结来源",
      stageAcceptance: "逐帧核验",
    };
    const skillThemePrompt = {
      skillId,
      themePrompt: "暗蓝效果",
      changes: "修改材质",
      acceptanceCriteria: "保持时间轴",
      exclusions: "不修改命中范围",
    };
    const professionPromptSha256 = sha256JcsV1(professionPrompt);
    const frozen = {
      skillId,
      professionPrompt,
      professionPromptSha256,
      skillThemePrompt,
      sourceEvidence: {
        sourceRunId: uuid(70 + index),
        sourceInventoryId: uuid(80 + index),
        sourceFrameManifestArtifactId: uuid(90 + index),
        sourceEntries: [
          {
            sourceInventoryEntryId: uuid(100 + index),
            sourceMetadataSha256: "C".repeat(64),
          },
        ],
      },
    };
    return {
      ...frozen,
      promptSha256: sha256JcsV1(
        createStyleSkillPromptComposition(themeDefinition, frozen),
      ),
    };
  });
  const promptPackage = {
    schemaVersion: 2 as const,
    themeDefinition,
    skills,
  };
  return {
    schemaVersion: 1,
    profileId: "aseprite-production-v1",
    parameters: {
      workflow: "style-skill-production-v2",
      professionId,
      styleId,
      selectedSkillIds: [...skillIds],
      promptPackage,
      promptPackageSha256: sha256JcsV1(promptPackage),
      toolProfiles: ["aseprite-cli"],
      deploymentAuthorized: false,
    },
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function requireRow(
  value: ProfessionProductionEvidenceRow | undefined,
): ProfessionProductionEvidenceRow {
  if (!value) throw new Error("TEST_PRODUCTION_REQUIRED");
  return value;
}

function requireArtifact(
  value: ProfessionCompletionArtifactRow | undefined,
): ProfessionCompletionArtifactRow {
  if (!value) throw new Error("TEST_ARTIFACT_REQUIRED");
  return value;
}

function requireId(value: string | null): string {
  if (!value) throw new Error("TEST_ARTIFACT_ID_REQUIRED");
  return value;
}
