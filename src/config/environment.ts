import { z } from "zod";
import { resolveOpenAiEndpoint } from "./openai-endpoint.js";

const loopbackHostSchema = z.enum(["127.0.0.1", "::1", "localhost"]); // 仅允许本地回环地址，避免意外暴露服务。

/**
 * 验证环境变量的完整性和一致性，确保数据库、Worker 凭据和模型端点配置正确。
 * 仅在应用启动时调用一次，拒绝缺失或错误的配置。
 * @throws {z.ZodError} 如果环境变量不符合预期格式或逻辑约束。
 */
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

const credentialMasterKeySchema = z.string().superRefine((value, context) => {
  try {
    if (Buffer.from(value, "base64url").length !== 32) {
      context.addIssue({
        code: "custom",
        message: "模型凭据主密钥必须是 32 字节 base64url。",
      });
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "模型凭据主密钥必须是有效 base64url。",
    });
  }
});

const objectStorageEndpointSchema = z.string().superRefine((value, context) => {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "对象存储端点必须是有效 URL。",
    });
    return;
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/") ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    context.addIssue({
      code: "custom",
      message:
        "对象存储端点只能使用不含凭据、路径或查询的本机回环 HTTP(S) URL。",
    });
  }
});

const objectStorageAccessKeySchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: loopbackHostSchema.default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(56_789), // 仅允许非特权端口，避免与系统服务冲突。
    CORS_ORIGINS: z.string().default("http://127.0.0.1:5173"), // 仅允许本地开发环境访问，避免意外暴露服务。
    DATABASE_URL: z.string().regex(/^mysql:\/\//u),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    DNF_REPOSITORY_ROOT: z.string().min(1).default("../dnf-patch"),
    RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    RESOURCE_IMPORT_PROJECT_ID: z.uuid().optional(),
    RESOURCE_IMPORT_SNAPSHOT_ID: z.uuid().optional(),
    OBJECT_STORAGE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    OBJECT_STORAGE_ENDPOINT: objectStorageEndpointSchema.default(
      "http://127.0.0.1:9000",
    ),
    OBJECT_STORAGE_REGION: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u)
      .default("us-east-1"),
    OBJECT_STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
      .default("dnf-patch-artifacts"),
    OBJECT_STORAGE_ACCESS_KEY: objectStorageAccessKeySchema.optional(),
    OBJECT_STORAGE_SECRET_KEY: z.string().min(32).max(256).optional(),
    OBJECT_STORAGE_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(900)
      .default(300),
    OBJECT_STORAGE_MAX_OBJECT_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(4_294_967_295)
      .default(2_147_483_648),
    OBJECT_STORAGE_MAX_RUN_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(Number.MAX_SAFE_INTEGER)
      .default(10_737_418_240),
    ARTIFACT_ORPHAN_REAPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    ARTIFACT_ORPHAN_REAPER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    CLIENT_SHARED_TOKEN: z.string().min(32),
    BROWSER_SESSION_SECRET: z.string().min(32),
    USER_REGISTRATION_TOKEN: z.string().min(32).optional(),
    MODEL_CREDENTIAL_MASTER_KEY: credentialMasterKeySchema.optional(),
    MODEL_CREDENTIAL_KEY_VERSION: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/u)
      .default("v1"),
    OPENAI_BASE_URL: openAiBaseUrlSchema.default("https://kldai.cc/v1"),
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
    if (value.BROWSER_SESSION_SECRET === value.CLIENT_SHARED_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["BROWSER_SESSION_SECRET"],
        message: "浏览器会话签名密钥必须与客户端共享令牌不同。",
      });
    }
    if (value.BROWSER_SESSION_SECRET === value.WORKER_SHARED_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["BROWSER_SESSION_SECRET"],
        message: "浏览器会话签名密钥必须与 Worker 令牌不同。",
      });
    }
    if (
      value.RESOURCE_IMPORT_SERVER_MIRROR_ENABLED &&
      (!value.RESOURCE_IMPORT_PROJECT_ID || !value.RESOURCE_IMPORT_SNAPSHOT_ID)
    ) {
      context.addIssue({
        code: "custom",
        path: ["RESOURCE_IMPORT_PROJECT_ID"],
        message: "启用资源镜像导入时必须配置 Project 与 Snapshot UUID。",
      });
    }
    if (
      (value.OBJECT_STORAGE_ACCESS_KEY === undefined) !==
      (value.OBJECT_STORAGE_SECRET_KEY === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OBJECT_STORAGE_ACCESS_KEY"],
        message: "对象存储 Access Key 与 Secret Key 必须同时配置。",
      });
    }
    if (
      value.OBJECT_STORAGE_ENABLED &&
      (!value.OBJECT_STORAGE_ACCESS_KEY || !value.OBJECT_STORAGE_SECRET_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OBJECT_STORAGE_ACCESS_KEY"],
        message: "启用对象存储时必须配置独立的应用访问凭据。",
      });
    }
    if (
      value.OBJECT_STORAGE_SECRET_KEY !== undefined &&
      [
        value.CLIENT_SHARED_TOKEN,
        value.WORKER_SHARED_TOKEN,
        value.BROWSER_SESSION_SECRET,
        value.USER_REGISTRATION_TOKEN,
      ].includes(value.OBJECT_STORAGE_SECRET_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OBJECT_STORAGE_SECRET_KEY"],
        message: "对象存储 Secret Key 必须与其他服务凭据不同。",
      });
    }
    if (
      value.OBJECT_STORAGE_MAX_RUN_BYTES < value.OBJECT_STORAGE_MAX_OBJECT_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["OBJECT_STORAGE_MAX_RUN_BYTES"],
        message: "单 Run 对象配额不能小于单对象上限。",
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
