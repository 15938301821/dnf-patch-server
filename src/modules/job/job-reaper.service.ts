/**
 * @fileoverview 在单个 Nest 进程内定期调用 JobService 回收过期 Worker lease；不签发 Job、不自行修改数据库、
 * 不执行 Worker 工具，也不保证多副本部署间的全局唯一调度。
 * @module modules/job/reaper-service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Nest 完成启动后调用 onApplicationBootstrap，Service 安排首次 tick；每次 tick 委托
 * JobService.reapExpired，后者在数据库事务内锁定和回收 lease。销毁钩子取消后续 timer。
 * 输入输出：输入是经环境校验的间隔与 JobService；没有外部 DTO 或业务返回值，失败只写固定日志事件。
 * 副作用：维护一个 unref 的 Node 定时器，可能触发 JobService 的数据库状态更新和权威 Run 事件；本类自身
 * 不持久化或发送 WebSocket。
 * 安全边界：running 标志防止本进程重叠回收，destroyed 标志防止关闭后重排；多实例场景仍依赖 Repository
 * 的数据库 `FOR UPDATE SKIP LOCKED` 保障，不能把这个内存标志误认为分布式锁。失败不重抛到启动链路，
 * 但后续周期继续尝试，且日志不包含 lease/token/payload/路径。
 */
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
/** 单进程定时调度适配层，实际回收语义由 JobService/Repository 控制。 */
export class JobReaperService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  /** 只记录稳定错误码，避免将 Job/Worker 的敏感执行上下文写入日志。 */
  private readonly logger = new Logger(JobReaperService.name);
  /** 下一次 tick 的可取消 timer；unref 后不应单独阻止进程退出。 */
  private timer: NodeJS.Timeout | undefined;
  /** 防止上一次异步回收尚未结束时在同一进程重入。 */
  private running = false;
  /** 生命周期销毁标志，阻止 finally 中继续调度。 */
  private destroyed = false;

  /**
   * @param jobs Job 生命周期 Service，封装批量 lease 回收的事务语义。
   * @param config 已校验环境配置，提供受限回收间隔；不从网络或 Worker body 读取。
   */
  constructor(
    private readonly jobs: JobService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  /**
   * 启动后安排立即的首次回收。
   * @sideEffect 创建一个 0ms 的 unref timer；不会同步领取、完成或删除 Job。
   */
  onApplicationBootstrap(): void {
    this.destroyed = false;
    this.schedule(0);
  }

  /**
   * 模块销毁时取消下一次调度。
   * @sideEffect 标记 destroyed 并清理 timer；不会中断已经在数据库事务中的 reapExpired，事务由其自身完成/回滚。
   */
  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * 安排一次未来 tick。
   * @param delayMs 已校验的非负延迟；调用方仅使用 0 或环境配置间隔。
   * @sideEffect 创建并 unref timer；destroyed 时保持零副作用。
   */
  private schedule(delayMs: number): void {
    if (this.destroyed) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  /**
   * 执行一批 lease 回收并无论成功失败都安排下一次。
   * @sideEffect 调用 JobService.reapExpired，可能在下游事务更新 Job/Run/attempt/event；本方法捕获错误后只写
   * 稳定日志，避免一个暂时数据库故障终止后续生命周期调度。
   */
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

  /** 按环境配置安排下一个周期；销毁后不能重新创建 timer。 */
  private scheduleNext(): void {
    if (this.destroyed) return;
    this.schedule(
      this.config.getOrThrow("WORKER_REAPER_INTERVAL_MS", { infer: true }),
    );
  }
}
