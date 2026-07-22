/**
 * @fileoverview 单进程有界回收拒绝或过期上传会话对象；不删除 finalized Artifact。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "../../config/environment.js";
import { ArtifactService } from "./artifact.service.js";

@Injectable()
export class ArtifactOrphanReaperService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ArtifactOrphanReaperService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private destroyed = false;

  constructor(
    private readonly artifacts: ArtifactService,
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
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.running || this.destroyed) return;
    this.running = true;
    try {
      await this.artifacts.reapOrphans(
        this.config.getOrThrow("ARTIFACT_ORPHAN_REAPER_BATCH_SIZE", {
          infer: true,
        }),
      );
    } catch {
      this.logger.error("ARTIFACT_ORPHAN_REAPER_FAILED");
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.destroyed) return;
    this.schedule(
      this.config.getOrThrow("ARTIFACT_ORPHAN_REAPER_INTERVAL_MS", {
        infer: true,
      }),
    );
  }
}
