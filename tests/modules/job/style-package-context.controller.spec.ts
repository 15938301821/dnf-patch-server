/**
 * @fileoverview 验证 Package V3 context HTTP 边界的 Worker Guard、精确委托和严格响应 schema；
 * 不覆盖 Service 事务、MySQL、对象下载或真实封包工具。
 * @module modules/job/style-package-context-controller-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 首个纵向协议切片
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../../src/common/security/worker-token.guard.js";
import { sha256JcsV1 } from "../../../src/common/utils/canonical.js";
import { StylePackageContextController } from "../../../src/modules/job/style-package-context.controller.js";
import type { StylePackageContextService } from "../../../src/modules/job/style-package-context.service.js";
import type {
  RequestStylePackageContextV3,
  StylePackageContextEnvelopeV3,
} from "../../../src/modules/job/style-package-production.contracts.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: RequestStylePackageContextV3 = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
};

describe("StylePackageContextController", () => {
  const get = vi.fn();
  let controller: StylePackageContextController;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new StylePackageContextController({
      get,
    } as unknown as StylePackageContextService);
  });

  it("requires Worker authentication and delegates the exact lease", async () => {
    const envelope = validEnvelope();
    get.mockResolvedValue(envelope);
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      StylePackageContextController,
    ) as unknown[] | undefined;

    expect(guards).toContain(WorkerTokenGuard);
    await expect(controller.get(jobId, input)).resolves.toEqual(envelope);
    expect(get).toHaveBeenCalledWith(jobId, input);
  });

  it("rejects a Service response that exposes an object key", async () => {
    get.mockResolvedValue({
      ...validEnvelope(),
      objectKey: "private/package-input.zip",
    });

    await expect(controller.get(jobId, input)).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});

function validEnvelope(): StylePackageContextEnvelopeV3 {
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
  const context = {
    schemaVersion: 3 as const,
    workflow: "style-package-production-v3" as const,
    jobId,
    runId: "44444444-4444-4444-8444-444444444444",
    professionId: "55555555-5555-4555-8555-555555555555",
    styleId: "66666666-6666-4666-8666-666666666666",
    attempt: 2,
    packageProfile,
    packageProfileSha256: sha256JcsV1(packageProfile),
    skills: [
      {
        productionContractVersion: 5 as const,
        skillId: "77777777-7777-4777-8777-777777777777",
        sourceSha256: "3".repeat(64),
        promptSha256: "4".repeat(64),
        productionAttempt: 1,
        projectBundle: {
          artifactId: "88888888-8888-4888-8888-888888888888",
          mediaType: "application/zip" as const,
          byteLength: 100,
          sha256: "5".repeat(64),
        },
        validationBundle: {
          artifactId: "99999999-9999-4999-8999-999999999999",
          mediaType: "application/zip" as const,
          byteLength: 200,
          sha256: "6".repeat(64),
        },
      },
    ],
    safety: {
      deploymentAuthorized: false as const,
      deploymentPerformed: false as const,
      fullSkillCoverageProven: false as const,
      clientCompatibilityProven: false as const,
    },
  };
  return { context, contextSha256: sha256JcsV1(context) };
}
