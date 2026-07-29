/**
 * @fileoverview 保护最终候选 NPK V3 契约的工具冻结、上下文哈希、Artifact 唯一性与安全状态；
 * 不执行本机封包器、不读取对象正文，也不启用当前 V2 package 路由。
 * @module modules/job/style-package-production-contracts-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - V3 package 契约首个 fail-closed 切片
 *
 * Mock 边界：测试只使用 UUID 和摘要 fixture；通过不代表存在真实 packager、validator、
 * DirectXTex、候选 NPK 或客户端兼容证据。
 */
import { describe, expect, it } from "vitest";
import { sha256JcsV1 } from "../../../src/common/utils/canonical.js";
import {
  createStylePackageContextEnvelopeV3,
  reportStylePackageProductionV3Schema,
  stylePackageContextV3Schema,
  stylePackageProductionJobPayloadV3Schema,
  type StylePackageContextV3,
  type StylePackageProfileV3,
} from "../../../src/modules/job/style-package-production.contracts.js";
import {
  stylePackageCandidateArtifactProvenanceV3Schema,
  stylePackageManifestArtifactProvenanceV3Schema,
  stylePackageValidationArtifactProvenanceV3Schema,
} from "../../../src/modules/job/style-package-artifact-evidence.contracts.js";
import { parseJobPayload } from "../../../src/modules/job/job-payload-contracts.js";

const ids = {
  job: "00000000-0000-4000-8000-000000000001",
  run: "00000000-0000-4000-8000-000000000002",
  profession: "00000000-0000-4000-8000-000000000003",
  style: "00000000-0000-4000-8000-000000000004",
  worker: "00000000-0000-4000-8000-000000000005",
  lease: "00000000-0000-4000-8000-000000000006",
  skill: "00000000-0000-4000-8000-000000000007",
  project: "00000000-0000-4000-8000-000000000008",
  skillValidation: "00000000-0000-4000-8000-000000000009",
  package: "00000000-0000-4000-8000-000000000010",
  manifest: "00000000-0000-4000-8000-000000000011",
  packageValidation: "00000000-0000-4000-8000-000000000012",
} as const;

const sha = (character: string): string => character.repeat(64);

describe("style package production V3 contracts", () => {
  it("registers only the dedicated V3 shape for npk-package Jobs", () => {
    const packageProfile = validProfile();
    const payload = {
      schemaVersion: 1 as const,
      profileId: packageProfile.profileId,
      parameters: {
        workflow: "style-package-production-v3" as const,
        professionId: ids.profession,
        styleId: ids.style,
        selectedSkillIds: [ids.skill],
        packageProfile,
        packageProfileSha256: sha256JcsV1(packageProfile),
        safety: safeState(),
      },
    };

    expect(stylePackageProductionJobPayloadV3Schema.parse(payload)).toEqual(
      payload,
    );
    expect(parseJobPayload("npk-package", 1, payload)).toEqual(payload);
    expect(() =>
      parseJobPayload("npk-package", 1, {
        schemaVersion: 1,
        profileId: packageProfile.profileId,
        parameters: {},
      }),
    ).toThrow();
  });

  it("creates a canonical envelope from a complete frozen context", () => {
    const context = validContext();

    const envelope = createStylePackageContextEnvelopeV3(context);

    expect(envelope.context).toEqual(context);
    expect(envelope.contextSha256).toBe(sha256JcsV1(context));
  });

  it("rejects profile drift, repeated evidence and elevated safety states", () => {
    const driftedProfile = validContext();
    driftedProfile.packageProfileSha256 = sha("f");
    expect(stylePackageContextV3Schema.safeParse(driftedProfile).success).toBe(
      false,
    );

    const repeatedEvidence = validContext();
    const firstSkill = repeatedEvidence.skills[0];
    if (!firstSkill) throw new Error("TEST_PACKAGE_SKILL_REQUIRED");
    firstSkill.validationBundle.artifactId = ids.project;
    repeatedEvidence.packageProfileSha256 = sha256JcsV1(
      repeatedEvidence.packageProfile,
    );
    expect(
      stylePackageContextV3Schema.safeParse(repeatedEvidence).success,
    ).toBe(false);

    const missingSource = validContext() as unknown as {
      skills: Array<Record<string, unknown>>;
    };
    delete missingSource.skills[0]?.sourceSha256;
    expect(stylePackageContextV3Schema.safeParse(missingSource).success).toBe(
      false,
    );

    const elevatedSafety = validContext() as unknown as Record<string, unknown>;
    elevatedSafety.safety = {
      deploymentAuthorized: true,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    };
    expect(stylePackageContextV3Schema.safeParse(elevatedSafety).success).toBe(
      false,
    );
  });

  it("accepts three distinct finalized outputs in a passed report", () => {
    const context = validContext();
    const report = passedReport(context);

    expect(reportStylePackageProductionV3Schema.parse(report)).toEqual(report);
  });

  it("rejects output role aliasing, unknown fields and unstable errors", () => {
    const context = validContext();
    const aliased = passedReport(context);
    aliased.validationArtifactId = ids.package;
    expect(
      reportStylePackageProductionV3Schema.safeParse(aliased).success,
    ).toBe(false);

    expect(
      reportStylePackageProductionV3Schema.safeParse({
        workerId: ids.worker,
        leaseId: ids.lease,
        attempt: 2,
        packageContextSha256: sha256JcsV1(context),
        packageProfileSha256: context.packageProfileSha256,
        status: "blocked",
        errorCode: "contains spaces",
        command: "forbidden",
      }).success,
    ).toBe(false);
  });

  it("requires ordered fixed-role provenance for final package artifacts", () => {
    const context = validContext();
    const base = {
      schemaVersion: 3 as const,
      jobId: context.jobId,
      attempt: context.attempt,
      packageContextSha256: sha256JcsV1(context),
      packageProfileSha256: context.packageProfileSha256,
      safety: safeState(),
    };
    expect(
      stylePackageCandidateArtifactProvenanceV3Schema.parse({
        ...base,
        kind: "style-package-candidate-npk-v3",
      }),
    ).toMatchObject({ jobId: ids.job, attempt: 2 });
    expect(
      stylePackageManifestArtifactProvenanceV3Schema.parse({
        ...base,
        kind: "style-package-manifest-v3",
        package: { artifactId: ids.package, sha256: sha("a") },
      }).package.artifactId,
    ).toBe(ids.package);
    expect(
      stylePackageValidationArtifactProvenanceV3Schema.safeParse({
        ...base,
        kind: "style-package-validation-v3",
        package: { artifactId: ids.package, sha256: sha("a") },
        manifest: { artifactId: ids.manifest, sha256: sha("b") },
        ignored: true,
      }).success,
    ).toBe(false);
  });
});

function validProfile(): StylePackageProfileV3 {
  return {
    schemaVersion: 3,
    profileId: "npk-package-v3",
    outputMediaType: "application/octet-stream",
    packager: { toolId: "npk-packager-v1", sha256: sha("1") },
    validator: { toolId: "npk-validator-v1", sha256: sha("2") },
    directXTex: {
      toolId: "directxtex-v1",
      texconvSha256: sha("3"),
      texdiagSha256: sha("4"),
    },
    extractorSharp: {
      toolId: "extractorsharp-v1",
      coreSha256: sha("5"),
      jsonSha256: sha("6"),
      zlibSha256: sha("7"),
    },
  };
}

function validContext(): StylePackageContextV3 {
  const packageProfile = validProfile();
  return {
    schemaVersion: 3,
    workflow: "style-package-production-v3",
    jobId: ids.job,
    runId: ids.run,
    professionId: ids.profession,
    styleId: ids.style,
    attempt: 2,
    packageProfile,
    packageProfileSha256: sha256JcsV1(packageProfile),
    skills: [
      {
        skillId: ids.skill,
        sourceSha256: sha("3"),
        promptSha256: sha("4"),
        productionAttempt: 1,
        projectBundle: {
          artifactId: ids.project,
          mediaType: "application/zip",
          byteLength: 128,
          sha256: sha("5"),
        },
        validationBundle: {
          artifactId: ids.skillValidation,
          mediaType: "application/zip",
          byteLength: 256,
          sha256: sha("6"),
        },
      },
    ],
    safety: safeState(),
  };
}

function passedReport(context: StylePackageContextV3): {
  workerId: string;
  leaseId: string;
  attempt: number;
  packageContextSha256: string;
  packageProfileSha256: string;
  status: "passed";
  packageArtifactId: string;
  packageSha256: string;
  manifestArtifactId: string;
  manifestSha256: string;
  validationArtifactId: string;
  validationSha256: string;
  safety: StylePackageContextV3["safety"];
} {
  return {
    workerId: ids.worker,
    leaseId: ids.lease,
    attempt: context.attempt,
    packageContextSha256: sha256JcsV1(context),
    packageProfileSha256: context.packageProfileSha256,
    status: "passed",
    packageArtifactId: ids.package,
    packageSha256: sha("7"),
    manifestArtifactId: ids.manifest,
    manifestSha256: sha("8"),
    validationArtifactId: ids.packageValidation,
    validationSha256: sha("9"),
    safety: context.safety,
  };
}

function safeState(): StylePackageContextV3["safety"] {
  return {
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
  };
}
