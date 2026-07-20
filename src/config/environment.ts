import { z } from "zod";
import { resolveOpenAiEndpoint } from "./openai-endpoint.js";

const loopbackHostSchema = z.enum(["127.0.0.1", "::1", "localhost"]);
const openAiBaseUrlSchema = z.string().superRefine((value, context) => {
  try {
    resolveOpenAiEndpoint(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "模型端点无效。",
    });
  }
});

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: loopbackHostSchema.default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(56_789),
    CORS_ORIGINS: z.string().default("http://127.0.0.1:5173"),
    DATABASE_URL: z.string().regex(/^mysql:\/\//u),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    DNF_REPOSITORY_ROOT: z.string().min(1).default("../dnf-patch"),
    CLIENT_SHARED_TOKEN: z.string().min(32),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_BASE_URL: openAiBaseUrlSchema.default("https://api.openai.com/v1"),
    OPENAI_ORCHESTRATOR_MODEL: z.string().min(1).default("gpt-5.6-sol"),
    OPENAI_ENGINEER_MODEL: z.string().min(1).default("gpt-5.5"),
    OPENAI_IMAGE_MODEL: z.string().min(1).default("gpt-image-2"),
    OPENAI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(180_000),
    OPENAI_REQUEST_MAX_RETRIES: z.coerce
      .number()
      .int()
      .min(0)
      .max(10)
      .default(2),
    OUTBOX_DISPATCH_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    OUTBOX_DISPATCH_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    WORKER_SHARED_TOKEN: z.string().min(32),
    WORKER_LEASE_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
    WORKER_REAPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    WORKER_REAPER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
  })
  .superRefine((value, context) => {
    if (value.CLIENT_SHARED_TOKEN === value.WORKER_SHARED_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_SHARED_TOKEN"],
        message: "客户端与 Worker 凭据必须使用不同值。",
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

/** Nest ConfigModule 的唯一环境解析入口，拒绝缺失数据库或 Worker 凭据。 */
export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  return environmentSchema.parse(input);
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
