import { z } from "zod";
import { clientIdSchema } from "../../common/contracts/index.js";
import {
  declarativeParametersSchema,
  type AllowedJobKind,
} from "../guardrail/guardrail.contracts.js";

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

/** 当前 v1 只允许有界声明式参数；具体资源映射仍须由经验证事实源提供。 */
export function parseJobPayload(
  kind: AllowedJobKind,
  schemaVersion: number,
  payload: unknown,
): DeclarativeJobPayloadV1 {
  if (schemaVersion !== 1) {
    throw new Error("JOB_PAYLOAD_CONTRACT_NOT_REGISTERED");
  }
  return registeredContracts[kind].parse(payload);
}

const registeredContracts: Record<
  AllowedJobKind,
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
  "shared-fx": declarativeJobPayloadV1Schema,
  profession: declarativeJobPayloadV1Schema,
};
