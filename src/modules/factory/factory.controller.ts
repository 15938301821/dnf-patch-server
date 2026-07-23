/**
 * @fileoverview 暴露 Factory 列表、读取和创建 HTTP 路由；不访问 Drizzle、不计算配置哈希，也不创建
 * Run 或 Worker Job。
 * @module modules/factory/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：ApiAuthGuard 先完成普通业务入口认证，Nest 再调用本 Controller；每个端点使用
 * ZodValidationPipe 解析输入后委托 FactoryService，Service 负责业务规则和稳定错误映射。
 * 输入输出：输入是路由 id 或严格创建 DTO；输出是脱敏 FactoryView，不返回 Drizzle 行、策略原文以外的
 * 内部执行信息或任何 Worker 凭据。
 * 副作用：Controller 自身没有数据库和网络副作用；下游 Service 可能读取或创建 Factory 记录。
 * 安全边界：认证成功不等于 Controller 可跳过 schema 校验；Factory 配置仍由 Service 重算哈希并拒绝
 * 不一致声明，不能在路由层信任客户端摘要。
 */
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { clientIdSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createFactorySchema,
  type CreateFactoryInput,
  type FactoryView,
} from "./factory.contracts.js";
import { FactoryService } from "./factory.service.js";

@Controller("factories")
/** HTTP 路由适配层；只做输入校验和响应委托，不承载 Factory 业务状态机。 */
export class FactoryController {
  /** @param factories 纵向领域 Service，负责配置哈希和唯一性等业务规则。 */
  constructor(private readonly factories: FactoryService) {}

  /**
   * 返回当前启用的 Factory 列表。
   * @returns 按 Repository 定义顺序排列的脱敏 FactoryView；列表存在不代表每项已被某个 Worker 支持。
   */
  @Get()
  list(): Promise<FactoryView[]> {
    return this.factories.list();
  }

  /**
   * 读取一个启用 Factory。
   * @param id URL path 中经 clientIdSchema 校验的稳定 Factory 标识。
   * @returns 对客户端公开的 FactoryView；不存在时由 Service 返回稳定的 NOT_FOUND 错误。
   */
  @Get(":id")
  get(
    @Param("id", new ZodValidationPipe(clientIdSchema)) id: string,
  ): Promise<FactoryView> {
    return this.factories.get(id);
  }

  /**
   * 创建一条带内容哈希的 Factory 记录。
   * @param input body 中已按 createFactorySchema 校验的 DTO；Service 仍会重新计算 configSha256。
   * @returns 新创建且默认启用的 FactoryView，不代表任何 Run、Job 或部署已经发生。
   */
  @Post()
  create(
    @Body(new ZodValidationPipe(createFactorySchema)) input: CreateFactoryInput,
  ): Promise<FactoryView> {
    return this.factories.create(input);
  }
}
