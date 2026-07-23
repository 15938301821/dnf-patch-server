/**
 * @fileoverview 暴露不含配置细节的公开健康检查路由；不执行迁移、不返回连接串或凭据，也不代表所有
 * 领域能力可用。
 * @module modules/health/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ApiAuthGuard 明确放行 GET /v1/health 后，Nest 调用本 Controller；本类委托
 * HealthService 检查数据库连通性并映射为有限的 HealthView。
 * 输入输出：没有请求 body 或路径参数；输出仅包含服务版本、数据库可用性和检查时间，不暴露环境、
 * 数据库 URL、token 或对象存储配置。
 * 副作用：Controller 本身不写数据库；下游 ping 只验证连接，不创建业务记录。
 * 安全边界：`degraded` 只表示数据库当前不可用，不能被前端解释为迁移、Worker、模型、部署或游戏
 * 资源链路已验证。
 */
import { Controller, Get } from "@nestjs/common";
import { HealthService, type HealthView } from "./health.service.js";

@Controller("health")
/** 公开健康路由适配层；不承担启动配置、认证以外的领域授权或状态修复。 */
export class HealthController {
  /** @param health 健康 Service，负责把数据库 ping 映射为有限状态。 */
  constructor(private readonly health: HealthService) {}

  /**
   * 返回当前服务和数据库的有界健康摘要。
   * @returns HealthView；HTTP 成功仅表示检查请求已被处理，`status` 决定数据库是否可用。
   */
  @Get()
  async getHealth(): Promise<HealthView> {
    return this.health.check();
  }
}
