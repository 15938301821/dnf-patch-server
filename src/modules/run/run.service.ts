import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { GuardrailService } from "../guardrail/guardrail.service.js";
import type {
  CreateRunInput,
  RunEventQuery,
  RunEventView,
  RunView,
} from "./run.contracts.js";
import { RunRepository } from "./run.repository.js";

@Injectable()
export class RunService {
  constructor(
    private readonly runs: RunRepository,
    private readonly guardrail: GuardrailService,
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
    const existing = await this.runs.findByIdempotency(
      input.projectId,
      idempotencyKey,
    );
    if (existing) {
      return existing;
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
    return (
      await this.runs.create(input, idempotencyKey, randomUUID(), decisions)
    ).run;
  }

  async events(id: string, query: RunEventQuery): Promise<RunEventView[]> {
    await this.get(id);
    return this.runs.events(id, query);
  }
}
