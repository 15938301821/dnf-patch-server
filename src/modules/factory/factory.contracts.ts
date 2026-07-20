import { z } from "zod";
import {
  clientIdSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";

const allowedJobKindsSchema = z
  .array(allowedJobKindSchema)
  .min(1)
  .refine((values) => new Set(values).size === values.length, {
    message: "allowedJobKinds 不能包含重复项。",
  });

const factoryConfigV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    profileId: clientIdSchema,
    policyId: clientIdSchema,
    allowedJobKinds: allowedJobKindsSchema,
    arbitraryExecution: z.literal(false).default(false),
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict();

const factoryConfigV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    profileId: clientIdSchema,
    policyId: clientIdSchema,
    policySha256: sha256Schema,
    allowedJobKinds: allowedJobKindsSchema,
    jobContracts: z
      .array(
        z
          .object({
            kind: allowedJobKindSchema,
            schemaVersion: z.literal(1),
          })
          .strict(),
      )
      .min(1),
    arbitraryExecution: z.literal(false).default(false),
    deploymentAuthorized: z.literal(false).default(false),
  })
  .strict()
  .superRefine((value, context) => {
    const contractKinds = value.jobContracts.map((contract) => contract.kind);
    if (new Set(contractKinds).size !== contractKinds.length) {
      context.addIssue({
        code: "custom",
        path: ["jobContracts"],
        message: "jobContracts 不能包含重复 kind。",
      });
    }
    const expected = [...value.allowedJobKinds].sort();
    const actual = [...contractKinds].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      context.addIssue({
        code: "custom",
        path: ["jobContracts"],
        message: "jobContracts 必须与 allowedJobKinds 完全对应。",
      });
    }
  });

export const factoryConfigSchema = z.discriminatedUnion("schemaVersion", [
  factoryConfigV1Schema,
  factoryConfigV2Schema,
]);

export const createFactorySchema = z
  .object({
    id: clientIdSchema,
    version: z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/u),
    displayName: safeDisplayNameSchema,
    config: factoryConfigSchema,
    configSha256: sha256Schema,
  })
  .strict();

export type CreateFactoryInput = z.infer<typeof createFactorySchema>;
export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

export interface FactoryView {
  id: string;
  version: string;
  displayName: string;
  config: FactoryConfig;
  configSha256: string;
  enabled: boolean;
  createdAtUtc: string;
}
