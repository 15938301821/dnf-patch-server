/**
 * @fileoverview 验证 Artifact 孤儿对象清理定时器只在对象存储启用时调度，并使用受配置限制的批量大小；
 * 不连接真实 MySQL、MinIO/S3、Worker 或实际删除对象。
 * @module modules/artifact/orphan-reaper.service.spec
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接创建 ArtifactOrphanReaperService，并以 fake timers 推进 Nest 生命周期回调；
 * ArtifactService 和 ConfigService 均为最小 mock，不加载 AppModule。
 * 输入输出：配置 mock 返回启用标志、间隔和批量数；断言 reapOrphans 是否被调用及其 batch 参数，
 * 不证明真实数据库会话筛选、对象存储删除、分布式单实例协调或生产定时精度。
 * 副作用：fake timers 与 mock 函数在 afterEach 恢复；没有网络、数据库、对象存储或文件副作用。
 * 安全边界：存储禁用时不应调度清理，避免服务在没有对象存储配置的降级模式下发出无意义调用；
 * 启用时批量上限必须来自受校验配置，测试不把它当作真实删除成功的证明。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactOrphanReaperService } from "./artifact-orphan-reaper.service.js";

/** 每个测试恢复真实计时器，避免 fake timer 泄漏影响同进程其他异步测试。 */
describe("ArtifactOrphanReaperService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule cleanup when object storage is disabled", async () => {
    vi.useFakeTimers();
    /** 仅观察调度调用；不模拟也不证明真实 orphan 查询或删除。 */
    const artifacts = { reapOrphans: vi.fn().mockResolvedValue(undefined) };
    const config = {
      getOrThrow: vi.fn(() => false),
    };
    const service = new ArtifactOrphanReaperService(
      artifacts as never,
      config as never,
    );

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1);

    // 禁用存储时保持零副作用，避免降级部署持续触发不存在的对象存储链路。
    expect(artifacts.reapOrphans).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it("runs bounded cleanup when object storage is enabled", async () => {
    vi.useFakeTimers();
    const artifacts = { reapOrphans: vi.fn().mockResolvedValue(undefined) };
    const config = {
      getOrThrow: vi.fn((key: string) => {
        if (key === "OBJECT_STORAGE_ENABLED") return true;
        if (key === "ARTIFACT_ORPHAN_REAPER_BATCH_SIZE") return 7;
        return 30_000;
      }),
    };
    const service = new ArtifactOrphanReaperService(
      artifacts as never,
      config as never,
    );

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);

    // 断言受配置限制的批量参数被原样传递，不把一次调度误当作真实对象已删除。
    expect(artifacts.reapOrphans).toHaveBeenCalledWith(7);
    service.onModuleDestroy();
  });
});
