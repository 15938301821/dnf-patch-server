import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DatabaseService } from "../../common/db/database.service.js";
import {
  factories,
  guardrailDecisions,
  projects,
  runs,
} from "../../common/db/schema.js";
import { sha256Json } from "../../common/utils/canonical.js";
import { factoryConfigSchema } from "../factory/factory.contracts.js";
import type {
  FrameGuardrailInput,
  FrameGuardrailResult,
} from "./frame-guardrail.contracts.js";

@Injectable()
export class FrameGuardrailService {
  constructor(private readonly connection: DatabaseService) {}

  async evaluate(input: FrameGuardrailInput): Promise<FrameGuardrailResult> {
    const [binding] = await this.connection.database
      .select({ factoryConfig: factories.config })
      .from(runs)
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .innerJoin(factories, eq(factories.id, projects.factoryId))
      .where(eq(runs.id, input.runId))
      .limit(1);
    if (!binding) {
      throw new NotFoundException({
        code: "GUARDRAIL_RUN_NOT_FOUND",
        message: "Frame Guardrail 绑定的 Run 不存在。",
      });
    }
    const policyStatus = validateFramePolicyBinding(
      input,
      binding.factoryConfig,
    );
    if (policyStatus === "unavailable") {
      throw new ConflictException({
        code: "GUARDRAIL_POLICY_UNAVAILABLE",
        message: "Run 的冻结策略不可用于 Frame Guardrail。",
      });
    }
    if (policyStatus === "mismatch") {
      throw new ConflictException({
        code: "GUARDRAIL_POLICY_MISMATCH",
        message: "Frame Guardrail 策略与 Run 的冻结策略不一致。",
      });
    }
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

export type FramePolicyBindingStatus = "matched" | "mismatch" | "unavailable";

/** 只接受 Factory v2 的冻结策略，避免调用方伪造 Guardrail 的策略来源。 */
export function validateFramePolicyBinding(
  input: Pick<FrameGuardrailInput, "policyId" | "policySha256">,
  factoryConfig: unknown,
): FramePolicyBindingStatus {
  const parsed = factoryConfigSchema.safeParse(factoryConfig);
  if (!parsed.success || parsed.data.schemaVersion !== 2) {
    return "unavailable";
  }
  return parsed.data.policyId === input.policyId &&
    parsed.data.policySha256.toUpperCase() === input.policySha256.toUpperCase()
    ? "matched"
    : "mismatch";
}
