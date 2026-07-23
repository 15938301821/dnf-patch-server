/**
 * @fileoverview 在对象存储启用时单进程、有界回收拒绝或过期上传会话的对象；不删除 finalized Artifact、
 * 不读取对象正文、不执行 Worker Job，也不提供多实例协调。
 * @module modules/artifact/orphan-reaper
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：Nest 完成应用启动后调用 onApplicationBootstrap，本地 timer 触发本 Service，再委托
 * ArtifactService.reapOrphans；该 Service 最终通过 Repository 选择数据库会话并通过对象存储端口删除
 * 对象。模块销毁时由 Nest 调用 onModuleDestroy 终止下一轮调度。
 * 输入输出：输入来自已验证环境的启用开关、批大小和毫秒间隔；输出仅是后台清理效果，没有 HTTP 响应。
 * 副作用：每轮最多处理一个有界批次，先由下游标记过期/拒绝会话，再删对象，删除成功后才写删除标记。
 * 安全边界：orphan 只指未 finalized 且过期或被拒绝的上传会话对象，不代表任意 Artifact 都可删除。
 * 当前 timer 仅适用于单 Nest 进程；多副本没有 leader/分布式锁协调，不能据此宣称多实例安全。对象存储
 * 禁用时完全不安排任务，避免错误日志与零必要 I/O。
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

  /**
   * 在 Nest 应用启动完成后根据对象存储开关安排首轮清理。
   *
   * 调用关系：仅由 Nest 生命周期调用。关闭对象存储时直接返回，禁止创建 timer、调用 Repository 或发起
   * 对象删除；启用时的零延迟首轮仍由 tick 中的单运行标记串行化。
   *
   * @returns 无返回值；调度不代表已有 orphan，也不代表真实对象存储连接已验证。
   */
  onApplicationBootstrap(): void {
    this.destroyed = false;
    if (
      !this.config.getOrThrow("OBJECT_STORAGE_ENABLED", {
        infer: true,
      })
    ) {
      return;
    }
    this.schedule(0);
  }

  /**
   * 停止本进程的后续 orphan 清理调度。
   *
   * 调用关系：Nest 模块销毁时调用；已在执行的异步删除不能被此方法强制回滚，但 destroyed 标记阻止其
   * finally 分支重新安排下一轮。该停止不管理其他进程的 timer 或对象存储状态。
   */
  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * 安排一次不保持 Node 进程存活的本地 timer。
   *
   * @param delayMs 来自启动首轮或受环境校验的轮询间隔，单位为毫秒；销毁后不得重建 timer。
   * @returns 无返回值；timer 只负责调用 tick，不持有数据库事务或对象删除锁。
   */
  private schedule(delayMs: number): void {
    if (this.destroyed) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  /**
   * 串行执行一轮有界 orphan 清理，并无论成功或失败后尝试安排下一轮。
   *
   * 步骤：1. 用 running/destroyed 防止同一进程重入；2. 读取受校验的批大小并委托 Service；
   * 3. 仅记录稳定错误码，不让一次失败终止循环；4. 清除运行标记后在未销毁时安排下一轮。
   * 当前本地布尔锁不跨进程，不能替代数据库行锁或未来多实例 leader。失败时禁止伪造删除成功或标记
   * 会话已清理，Service 会让失败对象留给后续批次重试。
   */
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

  /**
   * 依据已验证的环境间隔安排后续轮次。
   *
   * 只由 tick 的 finally 调用，确保同一实例每轮结束后再开始下一轮；模块已销毁时不调度，
   * 这不表示对象存储删除具有跨进程互斥或事务原子性。
   */
  private scheduleNext(): void {
    if (this.destroyed) return;
    this.schedule(
      this.config.getOrThrow("ARTIFACT_ORPHAN_REAPER_INTERVAL_MS", {
        infer: true,
      }),
    );
  }
}
