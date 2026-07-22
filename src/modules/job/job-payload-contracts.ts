import { z } from "zod";
import { clientIdSchema } from "../../common/contracts/index.js";
import {
  declarativeParametersSchema,
  type AllowedJobKind,
} from "../guardrail/guardrail.contracts.js";
import { styleSkillProductionJobPayloadV2Schema } from "./style-skill-production.contracts.js";
import { sharedFxJobPayloadV1Schema } from "./shared-fx.contracts.js";

const declarativeJobPayloadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: clientIdSchema,
    parameters: declarativeParametersSchema,
  })
  .strict();

export type DeclarativeJobPayloadV1 = z.infer<
  typeof declarativeJobPayloadV1Schema
>;

export type RegisteredJobPayloadV1 =
  | DeclarativeJobPayloadV1
  | z.infer<typeof styleSkillProductionJobPayloadV2Schema>
  | z.infer<typeof sharedFxJobPayloadV1Schema>;

/** 当前 v1 只允许有界声明式参数；具体资源映射仍须由经验证事实源提供。 */
export function parseJobPayload(
  kind: AllowedJobKind,
  schemaVersion: number,
  payload: unknown,
): RegisteredJobPayloadV1 {
  if (schemaVersion !== 1) {
    throw new Error("JOB_PAYLOAD_CONTRACT_NOT_REGISTERED");
  }
  if (kind === "profession") {
    return styleSkillProductionJobPayloadV2Schema.parse(payload);
  }
  if (kind === "shared-fx") {
    return sharedFxJobPayloadV1Schema.parse(payload);
  }
  return registeredContracts[kind].parse(payload);
}

const registeredContracts: Record<
  Exclude<AllowedJobKind, "profession" | "shared-fx">,
  typeof declarativeJobPayloadV1Schema
> = {
  "context-freeze": declarativeJobPayloadV1Schema,
  inventory: declarativeJobPayloadV1Schema,
  "engineering-plan": declarativeJobPayloadV1Schema,
  "image-reference": declarativeJobPayloadV1Schema,
  "aseprite-adaptation": declarativeJobPayloadV1Schema,
  "npk-package": declarativeJobPayloadV1Schema,
  "independent-validation": declarativeJobPayloadV1Schema,
  "manual-review": declarativeJobPayloadV1Schema,
  "bpk-package": declarativeJobPayloadV1Schema,
};
