/**
 * @fileoverview 暴露普通认证调用方查询和冻结 NPK Inventory 元数据的 HTTP 路由；不读取游戏目录、不解析
 * NPK/IMG、不执行工具，也不处理 Worker 精确 lease 回填。
 * @module modules/npk/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：全局 ApiAuthGuard 先认证普通业务请求，ZodValidationPipe 校验 path/body 后，本 Controller
 * 委托 NpkService；NpkService 负责 Run、可选 Artifact、路径冲突和稳定错误，Repository 负责写入事务。
 * 输入输出：输入是 Project id 和严格 Inventory DTO；输出是冻结 Inventory ViewModel 列表或单项，不返回
 * NPK 字节、对象 URL、游戏路径、工具参数或 Worker token。
 * 副作用：Controller 自身没有数据库/对象存储副作用；create 可在下游写入 Inventory 与条目记录。
 * 安全边界：当前路由只依赖全局普通认证，不在此层实施 Project 用户所有权校验；不得将此实现说明为
 * 已完成项目级多用户隔离。DTO 校验也不替代 Run/Artifact 归属或 Worker finalized Artifact 证据。
 */
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createInventorySchema,
  type CreateInventoryInput,
  type InventoryView,
} from "./npk.contracts.js";
import { NpkService } from "./npk.service.js";

@Controller("projects/:projectId/npk-inventories")
/** 普通 NPK Inventory HTTP 适配层，只处理输入校验与响应委托。 */
export class NpkController {
  /** @param inventories NPK 领域 Service，负责跨 Run/Artifact 的业务不变量。 */
  constructor(private readonly inventories: NpkService) {}

  /**
   * 返回一个 Project 已保存的 Inventory 摘要。
   * @param projectId 经 idSchema 校验的服务器 Project 标识。
   * @returns 按 Repository 排序的 InventoryView 数组；空数组不是错误，也不证明项目从未有过官方资源。
   */
  @Get()
  list(
    @Param("projectId", new ZodValidationPipe(idSchema)) projectId: string,
  ): Promise<InventoryView[]> {
    return this.inventories.list(projectId);
  }

  /**
   * 冻结由普通业务调用方提交的 Inventory 元数据。
   * @param projectId 经 idSchema 校验的 Project 标识。
   * @param input 经 createInventorySchema 校验的来源/条目 DTO；Service 仍验证 Run、可选 Artifact 与路径冲突。
   * @returns 新建 InventoryView；成功不证明服务器已经解析 NPK 正文或 Worker 处理完成。
   * @throws Service 映射 Run/Project/Artifact 不匹配、缺失或内部路径冲突等稳定业务错误。
   */
  @Post()
  create(
    @Param("projectId", new ZodValidationPipe(idSchema)) projectId: string,
    @Body(new ZodValidationPipe(createInventorySchema))
    input: CreateInventoryInput,
  ): Promise<InventoryView> {
    return this.inventories.create(projectId, input);
  }
}
