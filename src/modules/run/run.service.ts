import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isMysqlDuplicateEntry } from "../../common/db/mysql-errors.js";
import { FactoryService } from "../factory/factory.service.js";
import { GuardrailService } from "../guardrail/guardrail.service.js";
import { parseJobPayload } from "../job/job-payload-contracts.js";
import { ProjectService } from "../project/project.service.js";
import type {
  CreateRunInput,
  RunEventQuery,
  RunEventView,
  RunView,
} from "./run.contracts.js";
import { createRunRequestFingerprint } from "./run-fingerprint.js";
import { RunRepository, type RunIdempotencyRecord } from "./run.repository.js";

@Injectable()
export class RunService {
  constructor(
    private readonly runs: RunRepository,
    private readonly guardrail: GuardrailService,
    private readonly projects: ProjectService,
    private readonly factories: FactoryService,
  ) {}

  async get(id: string): Promise<RunView> {
    const run = await this.runs.findById(id);
    if (!run) {
      throw new NotFoundException({
        code: "RUN_NOT_FOUND",
        message: "Run 不存在。",
      });
    }
    return run;
  }

  async create(
    input: CreateRunInput,
    idempotencyKey: string,
  ): Promise<RunView> {
    const requestFingerprintSha256 = createRunRequestFingerprint(input);
    const existing = await this.runs.findByIdempotency(
      input.projectId,
      idempotencyKey,
    );
    if (existing) {
      return this.resolveReplay(existing, requestFingerprintSha256);
    }
    const project = await this.projects.get(input.projectId);
    if (project.archived) {
      throw new ConflictException({
        code: "PROJECT_ARCHIVED",
        message: "已归档项目不能创建 Run。",
      });
    }
    await this.projects.getSnapshot(input.projectId, input.snapshotId);
    const factory = await this.factories.get(project.factoryId);
    if (!factory.enabled) {
      throw new ConflictException({
        code: "FACTORY_DISABLED",
        message: "工厂模板已禁用。",
      });
    }
    if (factory.config.schemaVersion !== 2) {
      throw new ConflictException({
        code: "FACTORY_POLICY_VERSION_REQUIRED",
        message: "创建 Run 需要绑定策略哈希的 Factory v2 配置。",
      });
    }
    if (
      factory.config.policyId !== input.policyId ||
      factory.config.policySha256.toUpperCase() !==
        input.policySha256.toUpperCase()
    ) {
      throw new ConflictException({
        code: "RUN_POLICY_MISMATCH",
        message: "Run 策略与工厂冻结策略不一致。",
      });
    }
    const contracts = new Map(
      factory.config.jobContracts.map((contract) => [contract.kind, contract]),
    );
    for (const job of input.jobs) {
      const contract = contracts.get(job.kind);
      if (!factory.config.allowedJobKinds.includes(job.kind) || !contract) {
        throw new ConflictException({
          code: "JOB_KIND_NOT_ALLOWED",
          message: "工厂模板未允许提交的任务类型。",
        });
      }
      try {
        const payload = parseJobPayload(
          job.kind,
          contract.schemaVersion,
          job.payload,
        );
        if (payload.profileId !== factory.config.profileId) {
          throw new Error("JOB_PROFILE_MISMATCH");
        }
      } catch {
        throw new BadRequestException({
          code: "JOB_PAYLOAD_CONTRACT_FAILED",
          message: "任务参数不符合已注册的声明式契约。",
        });
      }
    }
    const decisions = input.jobs.map((job) =>
      this.guardrail.evaluate({
        policyId: input.policyId,
        policySha256: input.policySha256,
        jobKind: job.kind,
        payload: job.payload,
        deploymentAuthorized: false,
      }),
    );
    try {
      return (
        await this.runs.create(
          input,
          idempotencyKey,
          requestFingerprintSha256,
          randomUUID(),
          decisions,
        )
      ).run;
    } catch (error) {
      if (!isMysqlDuplicateEntry(error)) throw error;
      const replay = await this.runs.findByIdempotency(
        input.projectId,
        idempotencyKey,
      );
      if (replay) return this.resolveReplay(replay, requestFingerprintSha256);
      if (
        await this.runs.findByClientRunId(input.projectId, input.clientRunId)
      ) {
        throw new ConflictException({
          code: "CLIENT_RUN_ID_CONFLICT",
          message: "clientRunId 已被当前项目中的其他 Run 使用。",
        });
      }
      throw error;
    }
  }

  async events(id: string, query: RunEventQuery): Promise<RunEventView[]> {
    await this.get(id);
    return this.runs.events(id, query);
  }

  private resolveReplay(
    existing: RunIdempotencyRecord,
    requestFingerprintSha256: string,
  ): RunView {
    if (!existing.requestFingerprintSha256) {
      throw new ConflictException({
        code: "IDEMPOTENCY_RECORD_LEGACY",
        message: "历史 Run 缺少服务器请求指纹，不能安全重放。",
      });
    }
    if (existing.requestFingerprintSha256 !== requestFingerprintSha256) {
      throw new ConflictException({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Idempotency-Key 已用于不同请求。",
      });
    }
    return existing.run;
  }
}
