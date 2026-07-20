import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ArtifactView,
  CreateArtifactInput,
} from "./artifact.contracts.js";
import { ArtifactRepository } from "./artifact.repository.js";

@Injectable()
export class ArtifactService {
  constructor(private readonly artifacts: ArtifactRepository) {}

  create(runId: string, input: CreateArtifactInput): Promise<ArtifactView> {
    return this.artifacts.create(runId, randomUUID(), input);
  }

  listByRun(runId: string): Promise<ArtifactView[]> {
    return this.artifacts.listByRun(runId);
  }
}
