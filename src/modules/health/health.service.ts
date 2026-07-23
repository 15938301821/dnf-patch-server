/**
 * @fileoverview 将数据库连通性探测映射为公开且脱敏的服务健康摘要；不迁移数据库、不重试业务任务，
 * 也不检查对象存储、Worker、模型或游戏目录。
 * @module modules/health/service
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：HealthController 调用 check；本类通过 DatabaseService.ping 检查当前数据库连接。
 * 输入输出：没有调用方传入的开放输入；输出为有限的 HealthView，不返回原始数据库错误或连接信息。
 * 副作用：执行一次只读连接探测；不写入业务表、不启动迁移或恢复流程。
 * 安全边界：数据库失败只能降级为 `degraded`，不能泄露错误详情，也不能把服务进程仍在运行误报为
 * 数据库和全部生产链路健康。
 */
import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../common/db/database.service.js";

/**
 * 健康端点的公开 ViewModel（面向调用方的脱敏响应结构）。
 * `database` 只反映本次 ping，`status` 不证明对象存储、Worker、模型、迁移或客户端兼容性。
 */
export interface HealthView {
  schemaVersion: 1;
  status: "ok" | "degraded";
  service: "dnf-patch-server";
  version: string;
  database: "available" | "unavailable";
  checkedAtUtc: string;
}

@Injectable()
/** 将基础设施 ping 转换为稳定健康状态的业务 Service。 */
export class HealthService {
  /** @param database 应用生命周期管理的数据库访问入口，仅用于只读 ping。 */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 检查数据库是否可达并返回不泄露内部错误的健康摘要。
   *
   * 步骤 1：乐观假定可用并执行 ping；步骤 2：捕获任意基础设施错误后仅记录 `unavailable`；
   * 步骤 3：根据有限数据库状态派生 `ok` 或 `degraded`。失败不抛给公开健康端点，避免监控因
   * 数据库暂时不可用而失去服务进程状态，同时也不伪造数据库成功。
   *
   * @returns 当前时刻的 HealthView；不缓存结果，不代表后续请求仍可使用数据库。
   */
  async check(): Promise<HealthView> {
    let database: HealthView["database"] = "available";
    try {
      await this.database.ping();
    } catch {
      database = "unavailable";
    }
    return {
      schemaVersion: 1,
      status: database === "available" ? "ok" : "degraded",
      service: "dnf-patch-server",
      version: "0.1.0",
      database,
      checkedAtUtc: new Date().toISOString(),
    };
  }
}
