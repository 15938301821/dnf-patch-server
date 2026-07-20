import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import { guardrailDecisions } from "../../common/db/schema.js";
import { sha256Json } from "../../common/utils/canonical.js";
import type {
  FrameGuardrailInput,
  FrameGuardrailResult,
} from "./frame-guardrail.contracts.js";

@Injectable()
export class FrameGuardrailService {
  constructor(private readonly connection: DatabaseService) {}

  async evaluate(input: FrameGuardrailInput): Promise<FrameGuardrailResult> {
    const checks = {
      sourceHash:
        input.candidate.sourceSha256.toUpperCase() ===
        input.source.sha256.toUpperCase(),
      size:
        input.candidate.geometry.width === input.source.geometry.width &&
        input.candidate.geometry.height === input.source.geometry.height &&
        input.candidate.geometry.canvasWidth ===
          input.source.geometry.canvasWidth &&
        input.candidate.geometry.canvasHeight ===
          input.source.geometry.canvasHeight,
      anchor:
        input.candidate.geometry.x === input.source.geometry.x &&
        input.candidate.geometry.y === input.source.geometry.y,
      alpha:
        input.source.alphaNonZeroPixels === 0 ||
        input.candidate.alphaNonZeroPixels > 0,
    };
    const failed = Object.entries(checks).find(([, passed]) => !passed)?.[0];
    const decision = failed ? "deny" : "allow";
    const reasonCode = failed
      ? `FRAME_${failed.toUpperCase()}_MISMATCH`
      : "FRAME_INVARIANTS_PASSED";
    const id = randomUUID();
    const createdAt = new Date();
    await this.connection.database.insert(guardrailDecisions).values({
      id,
      runId: input.runId,
      policyId: input.policyId,
      policySha256: input.policySha256.toUpperCase(),
      inputSha256: sha256Json(input),
      decision,
      reasonCode,
      details: checks,
      createdAt,
    });
    return {
      id,
      runId: input.runId,
      decision,
      reasonCode,
      checks,
      createdAtUtc: createdAt.toISOString(),
    };
  }
}
