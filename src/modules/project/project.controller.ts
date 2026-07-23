/**
 * @fileoverview 暴露 Project 列表、读取、创建和 Snapshot 冻结 HTTP 路由；不直接访问 Drizzle、读取
 * 开发期仓库、创建 Run/Job 或执行 Worker 工具。
 * @module modules/project/controller
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：全局认证 Guard 先完成请求身份处理，Nest 使用 ZodValidationPipe 校验 path/body，再由
 * 本 Controller 委托 ProjectService；Service 负责 Factory 存在性、名称冲突和稳定错误。
 * 输入输出：输入是 Project id、创建 DTO 或 Snapshot 摘要 DTO；输出是脱敏 ViewModel，不返回规则正文、
 * Prompt、对象存储定位、Worker capability 或数据库内部字段。
 * 副作用：Controller 自身没有数据库或网络副作用；Service 可能创建 Project 或 Snapshot 记录。
 * 安全边界：DTO 摘要格式正确不代表引用文件已经导入或可安全执行；路由层不能提升
 * fullSkillCoverageProven，也不能绕过 Factory 验证或规范化名称冲突检查。
 */
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import {
  createProjectSchema,
  projectSnapshotSchema,
  type CreateProjectInput,
  type CreateProjectSnapshotInput,
  type ProjectSnapshotView,
  type ProjectView,
} from "./project.contracts.js";
import { ProjectService } from "./project.service.js";

@Controller("projects")
/** Project HTTP 适配层，只负责输入校验和响应委托，不承载持久化或 Run 状态机。 */
export class ProjectController {
  /** @param projects Project 业务 Service，负责跨 Factory 的业务不变量。 */
  constructor(private readonly projects: ProjectService) {}

  /**
   * 返回当前可查询 Project 的列表。
   * @returns Repository 定义排序的 ProjectView 集合；列表项存在不代表已拥有最新 Snapshot 或可创建 Run。
   */
  @Get()
  list(): Promise<ProjectView[]> {
    return this.projects.list();
  }

  /**
   * 根据服务器 Project id 读取单个项目。
   * @param id 经过 idSchema 校验的稳定服务器标识，不是 displayName 或 clientProjectId。
   * @returns ProjectView；不存在时由 Service 映射为 PROJECT_NOT_FOUND。
   */
  @Get(":id")
  get(
    @Param("id", new ZodValidationPipe(idSchema)) id: string,
  ): Promise<ProjectView> {
    return this.projects.get(id);
  }

  /**
   * 创建一个关联现有 Factory 的 Project。
   * @param input 经 createProjectSchema 解析的浏览器 DTO；Service 仍会验证 Factory 和规范化名称唯一性。
   * @returns 新建 ProjectView；不创建 Snapshot、Run、Job 或任何游戏资源。
   */
  @Post()
  create(
    @Body(new ZodValidationPipe(createProjectSchema)) input: CreateProjectInput,
  ): Promise<ProjectView> {
    return this.projects.create(input);
  }

  /**
   * 为已有 Project 保存开发期事实源的摘要 Snapshot。
   * @param projectId URL 中已校验的服务器 Project 标识。
   * @param input 经 projectSnapshotSchema 校验的摘要 DTO；摘要不包含实际源文件。
   * @returns 新建 ProjectSnapshotView；它不证明全技能覆盖、客户端兼容或部署授权。
   */
  @Post(":id/snapshots")
  createSnapshot(
    @Param("id", new ZodValidationPipe(idSchema)) projectId: string,
    @Body(new ZodValidationPipe(projectSnapshotSchema))
    input: CreateProjectSnapshotInput,
  ): Promise<ProjectSnapshotView> {
    return this.projects.createSnapshot(projectId, input);
  }
}
