/**
 * @fileoverview DNF Patch Server 进程启动入口；负责装配 NestJS/Fastify、全局 HTTP 边界、
 * CORS、关闭钩子与监听地址，不负责领域模块业务、数据库迁移或 Worker 本机工具执行。
 * @module bootstrap
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Node.js 载入本文件后调用 bootstrap；bootstrap 以 AppModule 为依赖图根，
 * 并从全局 ConfigService 读取已经 validateEnvironment 校验的启动配置。
 * 输入：进程环境派生的 HOST、PORT 与 CORS_ORIGINS；没有 HTTP 请求体输入。
 * 输出：启动一个带 /v1 前缀的 HTTP 服务；函数本身不返回业务数据。
 * 副作用：创建应用实例、注册全局异常过滤器和 CORS 策略、安装关闭钩子、占用监听端口并记录
 * 不含凭据的监听地址。启动任一步骤失败都会拒绝进程继续提供服务。
 * 安全边界：CORS 来源必须来自严格配置解析；异常响应必须经过脱敏过滤器；此入口不得输出
 * token、数据库连接串或模型凭据，也不得放宽 Worker 与浏览器入口的独立认证边界。
 */
import "./config/websocket-runtime.js";
import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { HttpExceptionFilter } from "./common/http/http-exception.filter.js";
import type { Environment } from "./config/environment.js";
import { parseCorsOrigins } from "./config/environment.js";

/**
 * 创建并启动唯一的 NestJS HTTP 应用实例。
 *
 * Nest Module 是依赖注入装配单元；实际业务由其下游 Controller（HTTP 路由适配层）和
 * Service（业务规则编排层）处理，本函数不介入领域状态机。
 *
 * @returns 应用成功绑定监听地址后完成；不返回应用实例，避免启动入口被当作可变运行时容器。
 * @throws 当依赖装配、必需配置读取或端口监听失败时向顶层传播错误，使进程 fail-closed
 * （缺少配置或证据时拒绝继续，而不是以宽松默认值运行）。
 */
async function bootstrap(): Promise<void> {
  // 步骤 1：先完成依赖图创建；任何 provider 构造失败时都不能开放监听端口。
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );
  const config = app.get(ConfigService<Environment, true>);
  // 步骤 2：只消费 environment schema 已验证的值；getOrThrow 防止缺失配置被静默降级。
  const host = config.getOrThrow("HOST", { infer: true });
  const port = config.getOrThrow("PORT", { infer: true });
  const origins = parseCorsOrigins(
    config.getOrThrow("CORS_ORIGINS", { infer: true }),
  );

  // 步骤 3：在监听前统一固定路由、脱敏错误响应和浏览器跨域边界。
  app.setGlobalPrefix("v1");
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Worker-Token",
    ],
  });
  // 步骤 4：先安装进程关闭钩子，再监听端口，保证数据库等 provider 有机会有序释放资源。
  app.enableShutdownHooks();
  await app.listen(port, host);
  Logger.log(`DNF Patch Server listening on http://${host}:${String(port)}/v1`);
}

await bootstrap();
