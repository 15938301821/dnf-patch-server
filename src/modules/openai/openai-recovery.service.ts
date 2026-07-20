/**
 * @fileoverview 在服务启动时收敛崩溃遗留的 ModelCall running 状态，不执行模型请求。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OpenAiRepository } from "./openai.repository.js";

interface ModelRecoveryConfigPort {
  getOrThrow(
    key: "OPENAI_REQUEST_TIMEOUT_MS" | "OPENAI_REQUEST_MAX_RETRIES",
    options: { infer: true },
  ): number;
}

interface ModelRecoveryRepositoryPort {
  abandonStale(timeoutMs: number): Promise<number>;
}

const recoveryRetryIntervalMs = 5_000;

/** 启动时收敛 stale ModelCall；数据库暂不可用时不阻断服务降级启动。 */
@Injectable()
export class OpenAiRecoveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OpenAiRecoveryService.name);
  private timer: NodeJS.Timeout | undefined;
  private destroyed = false;

  constructor(
    @Inject(OpenAiRepository)
    private readonly calls: ModelRecoveryRepositoryPort,
    @Inject(ConfigService)
    private readonly config: ModelRecoveryConfigPort,
  ) {}

  /** 启动时按 SDK 超时与重试上限计算最大窗口，超时记录统一标为 abandoned。 */
  async onApplicationBootstrap(): Promise<void> {
    this.destroyed = false;
    await this.recover();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 数据库错误仅记录稳定错误码并重试，避免破坏 degraded health 契约。 */
  private async recover(): Promise<void> {
    const timeoutMs = this.config.getOrThrow("OPENAI_REQUEST_TIMEOUT_MS", {
      infer: true,
    });
    const maxRetries = this.config.getOrThrow("OPENAI_REQUEST_MAX_RETRIES", {
      infer: true,
    });
    try {
      await this.calls.abandonStale(timeoutMs * (maxRetries + 1));
    } catch {
      this.logger.error("MODEL_CALL_RECOVERY_FAILED");
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.destroyed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recover();
    }, recoveryRetryIntervalMs);
    this.timer.unref();
  }
}
