/**
 * @fileoverview 验证 Package V3 context Repository 在当前 Job 行锁内按冻结顺序聚合 passed 技能，
 * 并拒绝旧 lease、角色互换或 provenance 漂移；不连接真实 MySQL、对象存储或封包工具。
 * @module modules/job/style-package-context-repository-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 首个纵向协议切片
 */
import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../../../src/common/db/database.service.js";
import {
  sha256JcsV1,
  sha256Json,
} from "../../../src/common/utils/canonical.js";
import { StylePackageContextRepository } from "../../../src/modules/job/style-package-context.repository.js";
import type {
  ArtifactFixture,
  ProductionFixture,
  UploadFixture,
} from "./fixtures/style-package-context.repository.spec-support.js";
import { createOutputUploadFixture } from "./fixtures/style-package-context.repository.spec-support.js";
import type {
  RequestStylePackageContextV3,
  StylePackageProductionJobPayloadV3,
} from "../../../src/modules/job/style-package-production.contracts.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const workerId = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const professionId = "44444444-4444-4444-8444-444444444444";
const styleId = "55555555-5555-4555-8555-555555555555";
const firstSkillId = "66666666-6666-4666-8666-666666666666";
const secondSkillId = "77777777-7777-4777-8777-777777777777";
const productionJobId = "88888888-8888-4888-8888-888888888888";
const firstProductionLeaseId = "89898989-8989-4989-8989-898989898989";
const secondProductionLeaseId = "90909090-9090-4090-8090-909090909090";
const firstProjectsId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstValidationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const secondProjectsId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const secondValidationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const firstProjectsUploadId = "abababab-abab-4bab-8bab-abababababab";
const firstValidationUploadId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";
const secondProjectsUploadId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const secondValidationUploadId = "dededede-dede-4ede-8ede-dededededede";

describe("StylePackageContextRepository.resolve", () => {
  it("restores payload order and returns a canonical attempt-bound envelope", async () => {
    const harness = repositoryHarness();

    const result = await harness.repository.resolve(jobId, request());

    expect(result).toMatchObject({
      status: "accepted",
      envelope: {
        context: {
          schemaVersion: 3,
          workflow: "style-package-production-v3",
          jobId,
          runId,
          professionId,
          styleId,
          attempt: 2,
          skills: [
            {
              skillId: firstSkillId,
              productionAttempt: 1,
              projectBundle: { artifactId: firstProjectsId },
              validationBundle: { artifactId: firstValidationId },
            },
            {
              skillId: secondSkillId,
              productionAttempt: 3,
              projectBundle: { artifactId: secondProjectsId },
              validationBundle: { artifactId: secondValidationId },
            },
          ],
          safety: {
            deploymentAuthorized: false,
            deploymentPerformed: false,
            fullSkillCoverageProven: false,
            clientCompatibilityProven: false,
          },
        },
      },
    });
    if (result.status !== "accepted") {
      throw new Error("TEST_ACCEPTED_CONTEXT_REQUIRED");
    }
    expect(result.envelope.contextSha256).toMatch(/^[A-F0-9]{64}$/u);
    expect(harness.forUpdate).toHaveBeenCalledWith("update");
    expect(harness.select).toHaveBeenCalledTimes(6);
  });

  it("rejects validation provenance that binds a different projects digest", async () => {
    const artifacts = validArtifacts();
    const validation = artifacts.find(
      (artifact) => artifact.id === firstValidationId,
    );
    if (!validation) throw new Error("TEST_VALIDATION_ARTIFACT_REQUIRED");
    validation.provenance = {
      ...(validation.provenance as Record<string, unknown>),
      asepriteProjects: {
        artifactId: firstProjectsId,
        sha256: "F".repeat(64),
      },
    };
    const harness = repositoryHarness({ artifacts });

    await expect(harness.repository.resolve(jobId, request())).resolves.toEqual(
      { status: "package-evidence-incomplete" },
    );
  });

  it("rejects validation quality evidence that drifts from projects", async () => {
    const artifacts = validArtifacts();
    const uploads = validUploads();
    const validation = artifacts.find(
      (artifact) => artifact.id === firstValidationId,
    );
    const validationUpload = uploads.find(
      (upload) => upload.id === firstValidationUploadId,
    );
    if (!validation || !validationUpload) {
      throw new Error("TEST_VALIDATION_EVIDENCE_REQUIRED");
    }
    const provenance = validation.provenance as Record<string, unknown>;
    validation.provenance = {
      ...provenance,
      referenceTransferQuality: {
        ...(provenance.referenceTransferQuality as Record<string, unknown>),
        referenceSimilarity: 0.95,
      },
    };
    validationUpload.provenance = validation.provenance;
    const harness = repositoryHarness({ artifacts, uploads });

    await expect(harness.repository.resolve(jobId, request())).resolves.toEqual(
      { status: "package-evidence-incomplete" },
    );
  });

  it("rejects an upload session that is no longer finalized", async () => {
    // Artifact 行仍存在也不够；非 finalized 会话不能成为最终封包输入的 producing lease 证据。
    const uploads = validUploads();
    const projectsUpload = uploads.find(
      (upload) => upload.id === firstProjectsUploadId,
    );
    if (!projectsUpload) throw new Error("TEST_PROJECTS_UPLOAD_REQUIRED");
    projectsUpload.status = "authorized";
    const harness = repositoryHarness({ uploads });

    await expect(harness.repository.resolve(jobId, request())).resolves.toEqual(
      { status: "package-evidence-incomplete" },
    );
  });

  it("rejects a stale attempt before reading package or Artifact evidence", async () => {
    const harness = repositoryHarness();

    await expect(
      harness.repository.resolve(jobId, { ...request(), attempt: 1 }),
    ).resolves.toEqual({ status: "lease-mismatch" });
    expect(harness.select).toHaveBeenCalledTimes(2);
  });
});

function request(): RequestStylePackageContextV3 {
  return { workerId, leaseId, attempt: 2 };
}

function repositoryHarness(options?: {
  artifacts?: ReturnType<typeof validArtifacts>;
  uploads?: ReturnType<typeof validUploads>;
}): {
  repository: StylePackageContextRepository;
  select: ReturnType<typeof vi.fn>;
  forUpdate: ReturnType<typeof vi.fn>;
} {
  const payload = validPayload();
  const forUpdate = vi.fn().mockResolvedValue([
    {
      id: jobId,
      runId,
      kind: "npk-package",
      status: "leased",
      leaseOwnerId: workerId,
      leaseId,
      leaseExpiresAt: new Date("2026-07-25T00:00:30.000Z"),
      attemptCount: 2,
      payload,
      payloadSha256: sha256Json(payload),
    },
  ]);
  const packageForUpdate = vi
    .fn()
    .mockResolvedValue([{ professionId, styleId, status: "queued" }]);
  const select = vi.fn(() => {
    const call = select.mock.calls.length;
    if (call === 1) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      };
    }
    if (call === 2) {
      return {
        from: vi.fn(() => ({
          limit: vi
            .fn()
            .mockResolvedValue([
              { value: new Date("2026-07-25T00:00:00.000Z") },
            ]),
        })),
      };
    }
    if (call === 3) {
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: packageForUpdate })),
          })),
        })),
      };
    }
    const rows =
      call === 4
        ? validProductions().reverse()
        : call === 5
          ? (options?.artifacts ?? validArtifacts().reverse())
          : (options?.uploads ?? validUploads().reverse());
    return {
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(rows),
      })),
    };
  });
  const transaction = vi.fn(
    (callback: (transaction: { select: typeof select }) => unknown) =>
      Promise.resolve(callback({ select })),
  );
  return {
    repository: new StylePackageContextRepository({
      database: { transaction },
    } as unknown as DatabaseService),
    select,
    forUpdate,
  };
}

function validPayload(): StylePackageProductionJobPayloadV3 {
  const packageProfile = {
    schemaVersion: 3 as const,
    profileId: "npk-package-v3",
    outputMediaType: "application/octet-stream" as const,
    packager: { toolId: "npk-packager-v3", sha256: "1".repeat(64) },
    validator: { toolId: "npk-validator-v3", sha256: "2".repeat(64) },
    directXTex: {
      toolId: "directxtex-v1",
      texconvSha256: "3".repeat(64),
      texdiagSha256: "4".repeat(64),
    },
    extractorSharp: {
      toolId: "extractorsharp-v1",
      coreSha256: "5".repeat(64),
      jsonSha256: "6".repeat(64),
      zlibSha256: "7".repeat(64),
    },
  };
  return {
    schemaVersion: 1,
    profileId: packageProfile.profileId,
    parameters: {
      workflow: "style-package-production-v3",
      professionId,
      styleId,
      selectedSkillIds: [firstSkillId, secondSkillId],
      packageProfile,
      packageProfileSha256: sha256JcsV1(packageProfile),
      safety: {
        deploymentAuthorized: false,
        deploymentPerformed: false,
        fullSkillCoverageProven: false,
        clientCompatibilityProven: false,
      },
    },
  };
}

function validProductions(): ProductionFixture[] {
  return [
    {
      skillId: firstSkillId,
      professionId,
      styleId,
      jobId: productionJobId,
      workerId,
      leaseId: firstProductionLeaseId,
      attempt: 1,
      sourceRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sourceFrameManifestArtifactId: "12345678-1234-4234-8234-123456789abc",
      promptSha256: "4".repeat(64),
      imageAttemptId: "3456789a-3456-4456-8456-3456789abcde",
      asepriteProfileId: "aseprite-cli",
      asepriteBinarySha256: "F".repeat(64),
      asepriteAdapterSha256: "0".repeat(64),
      asepriteArtifactId: firstProjectsId,
      asepriteUploadId: firstProjectsUploadId,
      validationArtifactId: firstValidationId,
      validationUploadId: firstValidationUploadId,
      status: "passed",
      errorCode: null,
      finishedAt: new Date("2026-07-24T00:01:00.000Z"),
    },
    {
      skillId: secondSkillId,
      professionId,
      styleId,
      jobId: productionJobId,
      workerId,
      leaseId: secondProductionLeaseId,
      attempt: 3,
      sourceRunId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sourceFrameManifestArtifactId: "12345678-1234-4234-8234-123456789abc",
      promptSha256: "5".repeat(64),
      imageAttemptId: "3456789a-3456-4456-8456-3456789abcde",
      asepriteProfileId: "aseprite-cli",
      asepriteBinarySha256: "F".repeat(64),
      asepriteAdapterSha256: "0".repeat(64),
      asepriteArtifactId: secondProjectsId,
      asepriteUploadId: secondProjectsUploadId,
      validationArtifactId: secondValidationId,
      validationUploadId: secondValidationUploadId,
      status: "passed",
      errorCode: null,
      finishedAt: new Date("2026-07-24T00:03:00.000Z"),
    },
  ];
}

function validArtifacts(): ArtifactFixture[] {
  return [
    outputArtifact(
      firstSkillId,
      productionJobId,
      1,
      firstProjectsId,
      "6",
      "projects",
    ),
    outputArtifact(
      firstSkillId,
      productionJobId,
      1,
      firstValidationId,
      "7",
      "validation",
      firstProjectsId,
      "6",
    ),
    outputArtifact(
      secondSkillId,
      productionJobId,
      3,
      secondProjectsId,
      "8",
      "projects",
    ),
    outputArtifact(
      secondSkillId,
      productionJobId,
      3,
      secondValidationId,
      "9",
      "validation",
      secondProjectsId,
      "8",
    ),
  ];
}

function validUploads(): UploadFixture[] {
  const productions = validProductions();
  const artifacts = validArtifacts();
  return [
    createOutputUploadFixture(
      runId,
      productions[0],
      artifacts[0],
      firstProjectsUploadId,
    ),
    createOutputUploadFixture(
      runId,
      productions[0],
      artifacts[1],
      firstValidationUploadId,
    ),
    createOutputUploadFixture(
      runId,
      productions[1],
      artifacts[2],
      secondProjectsUploadId,
    ),
    createOutputUploadFixture(
      runId,
      productions[1],
      artifacts[3],
      secondValidationUploadId,
    ),
  ];
}
function outputArtifact(
  skillId: string,
  producingJobId: string,
  attempt: number,
  id: string,
  shaCharacter: string,
  role: "projects" | "validation",
  projectsArtifactId?: string,
  projectsShaCharacter?: string,
): ArtifactFixture {
  const base = {
    schemaVersion: 2 as const,
    jobId: producingJobId,
    attempt,
    skillId,
    source: {
      runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      inventoryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      sourceSha256: "A".repeat(64),
      frameManifestArtifactId: "12345678-1234-4234-8234-123456789abc",
      frameManifestSha256: "B".repeat(64),
      frameManifestToolSha256: "C".repeat(64),
    },
    engineerPlan: {
      artifactId: "23456789-2345-4345-8345-23456789abcd",
      sha256: "D".repeat(64),
    },
    referenceImage: {
      imageAttemptId: "3456789a-3456-4456-8456-3456789abcde",
      artifactId: "456789ab-4567-4567-8567-456789abcdef",
      sha256: "E".repeat(64),
    },
    referenceTransferQuality: {
      schemaVersion: 1 as const,
      evaluatedFrameCount: 1,
      evaluatedPixelCount: 2,
      referenceCoverage: 1,
      referenceSimilarity: 1,
      sourceEdgeEnergy: 10,
      runtimeEdgeEnergy: 20,
      edgeEnergyRatio: 2,
    },
    aseprite: {
      profileId: "aseprite-cli" as const,
      binarySha256: "F".repeat(64),
      adapterSha256: "0".repeat(64),
    },
    safety: {
      referenceImageUsedAsRuntimeRgbSource: true as const,
      referenceImageDirectPixelReplacement: false as const,
      referenceTransferQualityPassed: true as const,
      sourceGeometryPreserved: true as const,
      sourceAlphaPreserved: true as const,
      deploymentAuthorized: false as const,
      deploymentPerformed: false as const,
      fullSkillCoverageProven: false as const,
      clientCompatibilityProven: false as const,
    },
  };
  const sha256 = shaCharacter.repeat(64);
  return {
    id,
    runId,
    storageKey: `artifacts/${id}`,
    logicalName:
      role === "projects"
        ? "profession-aseprite-projects.zip"
        : "profession-aseprite-validation.zip",
    mediaType: "application/zip",
    byteLength: 1_024,
    sha256,
    provenance:
      role === "projects"
        ? { ...base, kind: "profession-reference-projects-v2" as const }
        : {
            ...base,
            kind: "profession-reference-validation-v2" as const,
            asepriteProjects: {
              artifactId: projectsArtifactId,
              sha256: projectsShaCharacter?.repeat(64),
            },
          },
  };
}
