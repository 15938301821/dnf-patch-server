/**
 * @fileoverview 验证进程环境 schema 的安全默认值和跨字段 fail-closed 约束；不启动 Nest、MySQL、
 * MinIO、模型 Provider 或 Worker。
 * @module config/environment/tests
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 使用内存环境对象直接调用 validateEnvironment。输入中的重复字符仅是非秘密
 * 测试占位值，输出为解析结果或 ZodError；无外部副作用和 Mock。安全边界：测试证明配置门禁，
 * 不证明凭据部署、真实连接、认证加密、模型调用或对象存储权限正确。
 */
import { describe, expect, it } from "vitest";
import { validateEnvironment } from "./environment.js";

/** @returns 满足必填项且不会接触真实凭据的最小测试环境。 */
function validEnvironment(): Record<string, unknown> {
  return {
    DATABASE_URL: "mysql://runtime-user@127.0.0.1:3306/dnf_patch",
    CLIENT_SHARED_TOKEN: "c".repeat(32),
    WORKER_SHARED_TOKEN: "x".repeat(32),
    BROWSER_SESSION_SECRET: "s".repeat(32),
    MODEL_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
  };
}

describe("environment configuration", () => {
  // 防止缺省启动暴露外部监听，并固定后台轮询与禁用态基础设施的保守默认值。
  it("applies loopback-safe defaults", () => {
    expect(validateEnvironment(validEnvironment())).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 56_789,
      CORS_ORIGINS: "http://127.0.0.1:5173",
      OPENAI_BASE_URL: "https://kldai.cc/v1",
      OUTBOX_DISPATCH_INTERVAL_MS: 1_000,
      OUTBOX_DISPATCH_BATCH_SIZE: 25,
      WORKER_REAPER_INTERVAL_MS: 5_000,
      WORKER_REAPER_BATCH_SIZE: 25,
      RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: false,
      OBJECT_STORAGE_ENABLED: false,
      OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
      OBJECT_STORAGE_REGION: "us-east-1",
      OBJECT_STORAGE_BUCKET: "dnf-patch-artifacts",
      OBJECT_STORAGE_FORCE_PATH_STYLE: true,
      OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: 300,
      OBJECT_STORAGE_MAX_OBJECT_BYTES: 2_147_483_648,
      OBJECT_STORAGE_MAX_RUN_BYTES: 10_737_418_240,
      ARTIFACT_ORPHAN_REAPER_INTERVAL_MS: 30_000,
      ARTIFACT_ORPHAN_REAPER_BATCH_SIZE: 25,
    });
  });

  // 公网绑定必须在 provider 和监听端口创建前失败。
  it("rejects a public bind address", () => {
    expect(() =>
      validateEnvironment({ ...validEnvironment(), HOST: "0.0.0.0" }),
    ).toThrow();
  });

  // 过短 Worker token 不能进入内部 API Guard。
  it("rejects a short worker credential", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        WORKER_SHARED_TOKEN: "short",
      }),
    ).toThrow();
  });

  // 模型凭据主密钥缺失或字节数错误时必须拒绝启动，而不是降级明文保存。
  it("requires a valid model credential master key", () => {
    const missingKey = validEnvironment();
    delete missingKey.MODEL_CREDENTIAL_MASTER_KEY;
    expect(() => validateEnvironment(missingKey)).toThrow();
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        MODEL_CREDENTIAL_MASTER_KEY: Buffer.alloc(31, 7).toString("base64url"),
      }),
    ).toThrow();
  });

  // 普通客户端与 Worker 入口必须保持独立认证域。
  it("rejects shared client and worker credentials", () => {
    const token = "shared-token".repeat(3);
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        CLIENT_SHARED_TOKEN: token,
        WORKER_SHARED_TOKEN: token,
      }),
    ).toThrow();
  });

  // 服务端镜像导入没有明确 Project/Snapshot 归属时不得启用。
  it("requires project and snapshot identifiers when resource import is enabled", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: "true",
      }),
    ).toThrow();

    expect(
      validateEnvironment({
        ...validEnvironment(),
        RESOURCE_IMPORT_SERVER_MIRROR_ENABLED: "true",
        RESOURCE_IMPORT_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
        RESOURCE_IMPORT_SNAPSHOT_ID: "22222222-2222-4222-8222-222222222222",
      }).RESOURCE_IMPORT_SERVER_MIRROR_ENABLED,
    ).toBe(true);
  });

  // 禁用态无需凭据；启用后 Access/Secret Key 必须同时存在。
  it("requires independent credentials when object storage is enabled", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        OBJECT_STORAGE_ENABLED: "true",
      }),
    ).toThrow();

    expect(
      validateEnvironment({
        ...validEnvironment(),
        OBJECT_STORAGE_ENABLED: "true",
        OBJECT_STORAGE_ACCESS_KEY: "dnf-patch-app",
        OBJECT_STORAGE_SECRET_KEY: "o".repeat(32),
      }).OBJECT_STORAGE_ENABLED,
    ).toBe(true);
  });

  // 对象存储限定本机私有边界，本测试不建立真实 S3 连接。
  it("rejects public object storage endpoints", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        OBJECT_STORAGE_ENABLED: "true",
        OBJECT_STORAGE_ENDPOINT: "https://storage.example.com",
        OBJECT_STORAGE_ACCESS_KEY: "dnf-patch-app",
        OBJECT_STORAGE_SECRET_KEY: "o".repeat(32),
      }),
    ).toThrow();
  });

  // 防止一个泄露秘密同时打开 Worker API 和对象存储数据面。
  it("rejects an object storage secret reused as another service credential", () => {
    const workerToken = "w".repeat(32);
    expect(() =>
      validateEnvironment({
        ...validEnvironment(),
        WORKER_SHARED_TOKEN: workerToken,
        OBJECT_STORAGE_ENABLED: "true",
        OBJECT_STORAGE_ACCESS_KEY: "dnf-patch-app",
        OBJECT_STORAGE_SECRET_KEY: workerToken,
      }),
    ).toThrow();
  });
});
