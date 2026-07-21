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

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { bufferLogs: true },
  );
  const config = app.get(ConfigService<Environment, true>);
  const host = config.getOrThrow("HOST", { infer: true });
  const port = config.getOrThrow("PORT", { infer: true });
  const origins = parseCorsOrigins(
    config.getOrThrow("CORS_ORIGINS", { infer: true }),
  );

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
  app.enableShutdownHooks();
  await app.listen(port, host);
  Logger.log(`DNF Patch Server listening on http://${host}:${String(port)}/v1`);
}

await bootstrap();
