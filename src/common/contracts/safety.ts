import { z } from "zod";

/** 普通 API 无法提升这些状态；发布闭环只能保存外部核验证据。 */
export const immutableSafetyStateSchema = z.object({
  deploymentAuthorized: z.literal(false).default(false),
  deploymentPerformed: z.literal(false).default(false),
  fullSkillCoverageProven: z.literal(false).default(false),
  clientCompatibilityProven: z.literal(false).default(false),
});

export type ImmutableSafetyState = z.infer<typeof immutableSafetyStateSchema>;
