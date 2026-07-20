import { z } from "zod";
import {
  clientIdSchema,
  safeDisplayNameSchema,
  sha256Schema,
} from "../../common/contracts/index.js";

export const factoryConfigSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: clientIdSchema,
  policyId: clientIdSchema,
  allowedJobKinds: z
    .array(
      z.enum([
        "context-freeze",
        "inventory",
        "engineering-plan",
        "image-reference",
        "aseprite-adaptation",
        "npk-package",
        "independent-validation",
        "manual-review",
        "bpk-package",
        "shared-fx",
        "profession",
      ]),
    )
    .min(1),
  arbitraryExecution: z.literal(false).default(false),
  deploymentAuthorized: z.literal(false).default(false),
});

export const createFactorySchema = z.object({
  id: clientIdSchema,
  version: z.string().regex(/^[0-9]+(?:\.[0-9]+){0,2}$/u),
  displayName: safeDisplayNameSchema,
  config: factoryConfigSchema,
  configSha256: sha256Schema,
});

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
