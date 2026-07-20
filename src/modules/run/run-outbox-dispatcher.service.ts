/**
 * @fileoverview 以单进程 at-least-once 语义发布 Run outbox，不创建权威事件或业务状态。
 * @module run
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 transactional outbox
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { runEventOutboxSchema } from "./run.contracts.js";
import { RunGateway } from "./run.gateway.js";
import {
  RunOutboxRepository,
  type RunOutboxRepositoryPort,
} from "./run-outbox.repository.js";

interface OutboxConfigPort {
  getOrThrow(
    key: "OUTBOX_DISPATCH_INTERVAL_MS" | "OUTBOX_DISPATCH_BATCH_SIZE",
    options: { infer: true },
  ): number;
}

interface RunEventPublisherPort {
  publishRunEvent(
    runId: string,
    event: ReturnType<typeof runEventOutboxSchema.parse>["payload"],
  ): void;
}

/** 轮询并发布已提交的 Run 事件；不承担多进程协调或 exactly-once 保证。 */
@Injectable()
export class RunOutboxDispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RunOutboxDispatcherService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private destroyed = false;
  private consecutiveFailures = 0;

  constructor(
    @Inject(RunOutboxRepository)
    private readonly outbox: RunOutboxRepositoryPort,
    @Inject(RunGateway)
    private readonly publisher: RunEventPublisherPort,
    @Inject(ConfigService)
    private readonly config: OutboxConfigPort,
  ) {}

  onApplicationBootstrap(): void {
    this.destroyed = false;
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * 按创建顺序发布一个有界批次；广播成功后才条件标记 publishedAt。
   * 广播后进程崩溃会留下 pending 记录，重启后允许重复投递。
   */
  async dispatchPending(): Promise<number> {
    const batchSize = this.config.getOrThrow("OUTBOX_DISPATCH_BATCH_SIZE", {
      infer: true,
    });
    const rows = await this.outbox.listPending(batchSize);
    let published = 0;
    for (const row of rows) {
      const parsed = runEventOutboxSchema.safeParse(row);
      if (!parsed.success) throw new Error("RUN_OUTBOX_PAYLOAD_INVALID");
      this.publisher.publishRunEvent(
        parsed.data.aggregateId,
        parsed.data.payload,
      );
      if (!(await this.outbox.markPublished(parsed.data.id))) {
        throw new Error("RUN_OUTBOX_STATE_CONFLICT");
      }
      published += 1;
    }
    return published;
  }

  private schedule(delayMs: number): void {
    if (this.destroyed) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.destroyed) return;
    this.running = true;
    let nextDelay = this.intervalMs();
    try {
      const published = await this.dispatchPending();
      this.consecutiveFailures = 0;
      if (published === this.batchSize()) nextDelay = 0;
    } catch {
      this.consecutiveFailures += 1;
      nextDelay = Math.min(
        this.intervalMs() * 2 ** this.consecutiveFailures,
        60_000,
      );
      this.logger.error("RUN_OUTBOX_DISPATCH_FAILED");
    } finally {
      this.running = false;
      this.schedule(nextDelay);
    }
  }

  private intervalMs(): number {
    return this.config.getOrThrow("OUTBOX_DISPATCH_INTERVAL_MS", {
      infer: true,
    });
  }

  private batchSize(): number {
    return this.config.getOrThrow("OUTBOX_DISPATCH_BATCH_SIZE", {
      infer: true,
    });
  }
}
