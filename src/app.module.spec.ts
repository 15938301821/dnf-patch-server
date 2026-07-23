/**
 * @fileoverview 验证根应用依赖的环境 schema 保持本机安全默认值；不启动 Nest 应用，也不证明
 * 数据库、对象存储、外部模型、Socket.IO 或 Worker 集成可用。
 * @module application/tests
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接解析 environmentSchema，不经过 AppModule 或 main.ts。输入是仅供测试的
 *占位配置，输出是 schema 解析结果。无外部副作用，也未建立 Mock provider。
 * 安全边界：测试字符串不是部署凭据；断言只保护默认监听地址，不能扩大为模型外发已被完整验证。
 */
import { describe, expect, it } from "vitest";
import { environmentSchema } from "./config/environment.js";

describe("application safety defaults", () => {
  // 防止缺省配置把 HTTP 服务绑定到外部网卡；本单测不发起真实模型请求。
  it("keeps model egress unavailable without an API key", () => {
    const parsed = environmentSchema.safeParse({
      DATABASE_URL: "mysql://runtime-user@127.0.0.1:3306/dnf_patch",
      CLIENT_SHARED_TOKEN: "c".repeat(32),
      WORKER_SHARED_TOKEN: "w".repeat(32),
      BROWSER_SESSION_SECRET: "s".repeat(32),
      MODEL_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.HOST).toBe("127.0.0.1");
    }
  });
});
