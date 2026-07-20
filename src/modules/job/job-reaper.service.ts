import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import { JobService } from "./job.service.js";

@Injectable()
export class JobReaperService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(JobReaperService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private destroyed = false;

  constructor(
    private readonly jobs: JobService,
    private readonly config: ConfigService<Environment, true>,
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
    try {
      await this.jobs.reapExpired();
    } catch {
      this.logger.error("JOB_REAPER_FAILED");
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.destroyed) return;
    this.schedule(
      this.config.getOrThrow("WORKER_REAPER_INTERVAL_MS", { infer: true }),
    );
  }
}
