/**
 * @fileoverview 将浏览器共享特效请求编排为冻结来源和策略的 Worker Job；不执行工具或读取资源目录。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import { FactoryService } from "../factory/factory.service.js";
import { ProjectService } from "../project/project.service.js";
import type { CreateRunInput, RunCreateOptions } from "../run/run.contracts.js";
import { RunService } from "../run/run.service.js";
import { WorkerService } from "../worker/worker.service.js";
import {
  createSharedFxJobPayload,
  type SharedFxJobPayloadV1,
} from "./shared-fx.contracts.js";
import type {
  CreateSharedFxTaskInput,
  SharedFxTaskView,
} from "./shared-fx-task.contracts.js";

interface SharedFxProjectLookupPort {
  get(id: string): ReturnType<ProjectService["get"]>;
  getSnapshot(
    projectId: string,
    snapshotId: string,
  ): ReturnType<ProjectService["getSnapshot"]>;
}

interface SharedFxFactoryLookupPort {
  get(id: string): ReturnType<FactoryService["get"]>;
}

interface SharedFxWorkerCapabilityPort {
  hasEnabledCapability(
    capability: "shared-fx",
  ): ReturnType<WorkerService["hasEnabledCapability"]>;
}

interface SharedFxRunCreatePort {
  create(
    input: CreateRunInput,
    idempotencyKey: string,
    options?: RunCreateOptions,
  ): ReturnType<RunService["create"]>;
}

type FactoryV2Config = Extract<
  Awaited<ReturnType<FactoryService["get"]>>["config"],
  { schemaVersion: 2 }
>;

@Injectable()
export class SharedFxTaskService {
  constructor(
    @Inject(ProjectService)
    private readonly projects: SharedFxProjectLookupPort,
    @Inject(FactoryService)
    private readonly factories: SharedFxFactoryLookupPort,
    @Inject(WorkerService)
    private readonly workers: SharedFxWorkerCapabilityPort,
    @Inject(RunService) private readonly runs: SharedFxRunCreatePort,
  ) {}

  /**
   * 创建由服务端冻结的 shared-fx Run，并把稳定浏览器身份写入 Run owner。
   * 任何来源哈希、策略、阶段与安全状态均由已读取的 Snapshot 和 Factory 生成。
   */
  async create(
    input: CreateSharedFxTaskInput,
    idempotencyKey: string,
    ownerUserId: string,
  ): Promise<SharedFxTaskView> {
    const project = await this.projects.get(input.projectId);
    if (project.archived) {
      throw new ConflictException({
        code: "PROJECT_ARCHIVED",
        message: "已归档项目不能创建共享特效任务。",
      });
    }
    const snapshot = await this.projects.getSnapshot(
      input.projectId,
      input.snapshotId,
    );
    if (!snapshot.manifestSha256) {
      throw new ConflictException({
        code: "SHARED_FX_MANIFEST_REQUIRED",
        message: "共享特效任务需要已冻结的 manifest 哈希。",
      });
    }
    const factory = await this.factories.get(project.factoryId);
    const factoryConfig = requireSharedFxFactory(factory);
    if (!(await this.workers.hasEnabledCapability("shared-fx"))) {
      throw new ConflictException({
        code: "SHARED_FX_WORKER_REQUIRED",
        message: "尚无启用的 Worker 声明共享特效能力。",
      });
    }

    const payload = createSharedFxJobPayload({
      profileId: factoryConfig.profileId,
      policyId: factoryConfig.policyId,
      policySha256: factoryConfig.policySha256,
      snapshot,
    });
    const run = await this.runs.create(
      createSharedFxRunInput(input, factoryConfig, payload),
      idempotencyKey,
      { ownerUserId },
    );
    return {
      id: run.id,
      status: run.status === "blocked" ? "blocked" : "queued",
      createdAt: run.createdAtUtc,
    };
  }
}

/** 仅接受已启用且完整登记 shared-fx v1 的 Factory v2 策略。 */
function requireSharedFxFactory(
  factory: Awaited<ReturnType<FactoryService["get"]>>,
): FactoryV2Config {
  if (!factory.enabled) {
    throw new ConflictException({
      code: "FACTORY_DISABLED",
      message: "工厂模板已禁用。",
    });
  }
  if (factory.config.schemaVersion !== 2) {
    throw new ConflictException({
      code: "FACTORY_POLICY_VERSION_REQUIRED",
      message: "共享特效任务需要 Factory v2 冻结策略。",
    });
  }
  const contract = factory.config.jobContracts.find(
    (candidate) => candidate.kind === "shared-fx",
  );
  if (
    !factory.config.allowedJobKinds.includes("shared-fx") ||
    contract?.schemaVersion !== 1
  ) {
    throw new ConflictException({
      code: "SHARED_FX_CONTRACT_REQUIRED",
      message: "Factory 未启用 shared-fx v1 声明式契约。",
    });
  }
  return factory.config;
}

/** 构造可审计 Run 请求，但不接受调用方提供的 Worker 负载或安全状态。 */
function createSharedFxRunInput(
  input: CreateSharedFxTaskInput,
  factoryConfig: FactoryV2Config,
  payload: SharedFxJobPayloadV1,
): CreateRunInput {
  const request = {
    schemaVersion: 1,
    action: "generate-shared-fx",
    projectId: input.projectId,
    snapshotId: input.snapshotId,
    clientRunId: input.clientRunId,
    payload,
  };
  return {
    projectId: input.projectId,
    snapshotId: input.snapshotId,
    clientRunId: input.clientRunId,
    action: "generate-shared-fx",
    requestSha256: sha256JcsV1(request),
    serverConnectionEnabled: true,
    modelEgressAuthorized: false,
    deploymentAuthorized: false,
    deploymentPerformed: false,
    fullSkillCoverageProven: false,
    clientCompatibilityProven: false,
    jobs: [{ kind: "shared-fx", payload, maxAttempts: 3 }],
    policyId: factoryConfig.policyId,
    policySha256: factoryConfig.policySha256,
  };
}
