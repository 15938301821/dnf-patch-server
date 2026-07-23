/**
 * @fileoverview 定义服务端进程环境变量的唯一 Zod 解析入口；负责格式、范围、默认值和跨字段
 * 安全约束，不读取 .env 文件、不连接外部服务，也不向响应暴露配置或凭据。
 * @module config/environment
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 的 ConfigModule 在 provider 装配前调用 validateEnvironment；main.ts 与各
 * 基础设施 provider 只消费解析后的 Environment。输入是 Node.js 进程环境映射，输出是强类型
 * 配置和 CORS 来源数组。副作用仅限启动失败时抛出 ZodError；本文件不记录或持久化任何值。
 * 安全边界：网络监听保持回环地址；浏览器、Worker、会话及对象存储凭据必须相互隔离；模型
 * 主密钥只可短暂进入进程内存，不能进入日志、响应、数据库明文或测试快照。缺失组合证据时
 * 必须 fail-closed（拒绝启动，而不是猜测默认凭据或放宽外发）。
 */
import { z } from "zod";
import { resolveOpenAiEndpoint } from "./openai-endpoint.js";

/** 限制 HTTP 监听到本机回环接口，避免服务因环境误配暴露到局域网或公网。 */
const loopbackHostSchema = z.enum(["127.0.0.1", "::1", "localhost"]);

/**
 * 校验固定角色模型出站基础 URL；只接受 resolveOpenAiEndpoint 可规范化的 HTTPS `/v1` 端点。
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

/** 校验用户模型凭据的 AES-256-GCM 主密钥编码为恰好 32 字节 base64url。 */
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

/** 校验私有对象存储只使用无内嵌凭据、路径或查询参数的本机回环 HTTP(S) 端点。 */
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

/** 校验对象存储应用访问标识；Secret Key 使用独立字段且不会拼入端点 URL。 */
const objectStorageAccessKeySchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/**
 * 服务启动环境 schema；生产方是进程环境，消费方是 ConfigService 与基础设施 provider。
 * 每个字段都在任何 Controller 接收请求前完成运行时校验，未知环境变量可由进程保留但不会进入
 * 解析后的 Environment 对象。
 */
export const environmentSchema = z
  .object({
    /** 运行模式；缺省为 development，仅控制框架环境分支，不放宽认证。 */
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    /** HTTP 监听主机；固定为回环地址集合，缺省 127.0.0.1。 */
    HOST: loopbackHostSchema.default("127.0.0.1"),
    /** HTTP 监听端口，范围 1..65535，缺省 56789。 */
    PORT: z.coerce.number().int().min(1).max(65_535).default(56_789),
    /** 逗号分隔的浏览器来源白名单；由 parseCorsOrigins 拆分，不接受通配默认值。 */
    CORS_ORIGINS: z.string().default("http://127.0.0.1:5173"),
    /** MySQL 连接 URL；由 DatabaseService 消费，禁止写入日志或 HTTP 响应。 */
    DATABASE_URL: z.string().regex(/^mysql:\/\//u),
    /** MySQL 连接池最大连接数，范围 1..50，缺省 10。 */
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    /** 仅供受控资源导入读取的开发期仓库根；不是 Worker 游戏目录或 API 输入。 */
    DNF_REPOSITORY_ROOT: z.string().min(1).default("../dnf-patch"),
    /** 是否启用服务端资源镜像导入；缺省关闭，启用时必须同时绑定 Project 与 Snapshot。 */
    RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /** 镜像导入目标 Project UUID；仅在镜像开关开启时与 Snapshot 成对有效。 */
    RESOURCE_IMPORT_PROJECT_ID: z.uuid().optional(),
    /** 镜像导入来源 Snapshot UUID；不能脱离同组 Project 单独授权导入。 */
    RESOURCE_IMPORT_SNAPSHOT_ID: z.uuid().optional(),
    /** 是否启用私有 Artifact 对象存储；关闭时不得构造 S3 客户端或默认凭据链。 */
    OBJECT_STORAGE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    /** 本机 S3/MinIO 端点；只允许无凭据的回环 HTTP(S) URL。 */
    OBJECT_STORAGE_ENDPOINT: objectStorageEndpointSchema.default(
      "http://127.0.0.1:9000",
    ),
    /** S3 签名区域标识，1..63 个安全字符，缺省 us-east-1。 */
    OBJECT_STORAGE_REGION: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u)
      .default("us-east-1"),
    /** 私有 bucket 名；只保存 Artifact 对象，不创建公开访问策略。 */
    OBJECT_STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
      .default("dnf-patch-artifacts"),
    /** 对象存储应用 Access Key；只由 S3 provider 消费，必须与 Secret Key 成对出现。 */
    OBJECT_STORAGE_ACCESS_KEY: objectStorageAccessKeySchema.optional(),
    /** 对象存储应用 Secret Key；不记录、不回显，并且不得复用任何服务认证凭据。 */
    OBJECT_STORAGE_SECRET_KEY: z.string().min(32).max(256).optional(),
    /** 是否使用 path-style S3 URL；本机 MinIO 缺省为 true。 */
    OBJECT_STORAGE_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /** 上传/下载签名 URL 生存期，单位秒，范围 30..900。 */
    OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(900)
      .default(300),
    /** 单个对象允许的最大字节数，范围 1 MiB..4 GiB-1。 */
    OBJECT_STORAGE_MAX_OBJECT_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(4_294_967_295)
      .default(2_147_483_648),
    /** 同一 Run 的对象总配额，单位字节，且不得小于单对象上限。 */
    OBJECT_STORAGE_MAX_RUN_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(Number.MAX_SAFE_INTEGER)
      .default(10_737_418_240),
    /** 孤立 Artifact 清理器轮询间隔，单位毫秒，范围 1 秒..5 分钟。 */
    ARTIFACT_ORPHAN_REAPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    /** 孤立 Artifact 每轮最多处理数量，范围 1..100。 */
    ARTIFACT_ORPHAN_REAPER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    /** 旧式普通业务 API 的共享 Bearer token；不得用于稳定用户所有权。 */
    CLIENT_SHARED_TOKEN: z.string().min(32),
    /** 浏览器会话 HMAC 签名秘密；必须独立于 Client/Worker token，且不得持久化或回显。 */
    BROWSER_SESSION_SECRET: z.string().min(32),
    /** 可选用户注册门禁 token；仅用于注册入口，不等于登录会话或资源所有权。 */
    USER_REGISTRATION_TOKEN: z.string().min(32).optional(),
    /** 用户模型凭据认证加密主密钥；仅在内存中由凭据服务消费，不得进入数据库。 */
    MODEL_CREDENTIAL_MASTER_KEY: credentialMasterKeySchema,
    /** 主密钥版本标签；与用户、角色一起参与密文 AAD/轮换语义。 */
    MODEL_CREDENTIAL_KEY_VERSION: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/u)
      .default("v1"),
    /** 固定角色模型的 HTTPS `/v1` 基础 URL；不能内嵌凭据、查询或 fragment。 */
    OPENAI_BASE_URL: openAiBaseUrlSchema.default("https://kldai.cc/v1"),
    /** 编排角色的固定模型 ID；业务 DTO 不得临时覆盖。 */
    OPENAI_ORCHESTRATOR_MODEL: z.string().min(1).default("gpt-5.6-sol"),
    /** 工程角色的固定模型 ID；存在配置不证明外部 Provider 支持。 */
    OPENAI_ENGINEER_MODEL: z.string().min(1).default("gpt-5.5"),
    /** 图像角色的固定模型 ID；模型产物仍需独立证据与安全门禁。 */
    OPENAI_IMAGE_MODEL: z.string().min(1).default("gpt-image-2"),
    /** 单次模型请求超时，单位毫秒，范围 1 秒..10 分钟。 */
    OPENAI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(180_000),
    /** 模型网络请求最大重试次数，范围 0..10；不重试策略拒绝或解析失败。 */
    OPENAI_REQUEST_MAX_RETRIES: z.coerce
      .number()
      .int()
      .min(0)
      .max(10)
      .default(2),
    /** outbox dispatcher 轮询间隔，单位毫秒；outbox 是与业务状态同事务写入的待投递事件。 */
    OUTBOX_DISPATCH_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(1_000),
    /** outbox 每轮最大投递数量，范围 1..100。 */
    OUTBOX_DISPATCH_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
    /** 仅供内部 Worker API 的共享 token；必须与浏览器和客户端凭据不同。 */
    WORKER_SHARED_TOKEN: z.string().min(32),
    /** Worker Job 租约期限，单位秒，范围 15..600。 */
    WORKER_LEASE_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
    /** 过期租约回收器轮询间隔，单位毫秒，范围 1..60 秒。 */
    WORKER_REAPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(5_000),
    /** 过期租约每轮最大回收数量，范围 1..100。 */
    WORKER_REAPER_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25),
  })
  .superRefine((value, context) => {
    // 步骤 1：隔离三类认证秘密，防止一个泄露值横向进入浏览器、普通 API 与 Worker 入口。
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
    // 步骤 2：镜像导入开关只能与固定 Project/Snapshot 组合启用，禁止凭目录名猜测归属。
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
    // 步骤 3：对象存储凭据必须成对、启用时必填，并与全部服务认证秘密保持不同。
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
    // 步骤 4：Run 总配额必须容纳至少一个合法最大对象，避免产生不可满足的上传授权。
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

/** ConfigService 消费的已解析环境类型；不应序列化为 API ViewModel 或日志对象。 */
export type Environment = z.infer<typeof environmentSchema>;

/**
 * 在 Nest 依赖装配前解析全部服务配置。
 *
 * @param input ConfigModule 从进程环境收集的未知键值；其中秘密尚未被信任且不得记录。
 * @returns 经过默认值、类型转换、范围和组合不变量校验的 Environment。
 * @throws ZodError 当任一必需值缺失、格式越界、凭据复用或组合配置不完整时抛出并中止启动。
 */
export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  return environmentSchema.parse(input);
}

/**
 * 将已校验配置中的逗号分隔 CORS 白名单转换为 Fastify 可消费的来源数组。
 *
 * @param value environmentSchema 产出的 CORS_ORIGINS 原始字符串。
 * @returns 去除首尾空白和空段后的来源列表；不解析通配符，也不验证网络可达性。
 */
export function parseCorsOrigins(value: string): string[] {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
