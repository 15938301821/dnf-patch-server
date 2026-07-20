import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { RunService } from "../run/run.service.js";
import type {
  ArtifactView,
  CreateArtifactInput,
} from "./artifact.contracts.js";
import { ArtifactRepository } from "./artifact.repository.js";

@Injectable()
export class ArtifactService {
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly runs: RunService,
  ) {}

  findRunId(id: string): Promise<string | undefined> {
    return this.artifacts.findRunId(id);
  }

  async create(
    runId: string,
    input: CreateArtifactInput,
  ): Promise<ArtifactView> {
    await this.runs.get(runId);
    return this.artifacts.create(runId, randomUUID(), input);
  }

  listByRun(runId: string): Promise<ArtifactView[]> {
    return this.artifacts.listByRun(runId);
  }
}
