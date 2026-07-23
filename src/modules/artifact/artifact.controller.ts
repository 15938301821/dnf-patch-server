/**
 * @fileoverview 提供已 finalized Artifact 的 Run 级只读列表；不负责对象下载、上传、对象存储签名、
 * 事务或 Run 所有权判定，写入只能走 Worker 上传生命周期。
 * @module modules/artifact/controller
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：全局 ApiAuthGuard 先完成浏览器访问令牌或共享客户端令牌认证，Nest 将 URL 参数交给
 * 本 Controller；本类使用 ZodValidationPipe 校验 runId 后委托 ArtifactService，后者再读 Repository。
 * 输入输出：输入是路径中通过 UUID schema 校验的 runId，输出是 ArtifactView 数组，不含 storageKey、
 * 对象正文或短期 URL。返回对象已 finalized 的元数据，不代表对象可公开访问、下载已发生或补丁已部署。
 * 副作用：本 Controller 自身没有数据库、对象存储、事务或网络副作用；下游是只读查询。
 * 安全边界：Guard 的认证成功不等于 Run 领域所有权已获保证；不得在此路由增设绕过 Service/Repository
 * 的对象 key、bucket 或上传能力。
 */
import { Controller, Get, Param } from "@nestjs/common";
import { idSchema } from "../../common/contracts/index.js";
import { ZodValidationPipe } from "../../common/http/zod-validation.pipe.js";
import { type ArtifactView } from "./artifact.contracts.js";
import { ArtifactService } from "./artifact.service.js";

@Controller("runs/:runId/artifacts")
export class ArtifactController {
  constructor(private readonly artifacts: ArtifactService) {}

  /**
   * 返回指定 Run 的已持久化 Artifact ViewModel 列表。
   *
   * 调用关系：浏览器 GET `/v1/runs/:runId/artifacts` 经过全局 Guard 与 ZodValidationPipe 后调用；
   * Service/Repository 负责读取，Controller 不持有事务或对象存储能力。
   *
   * @param runId URL path 中已通过 idSchema 校验的 Run 标识，不是请求可任选的存储路径。
   * @returns 按创建时间排序的脱敏元数据；每项的 SHA-256 和长度用于完整性审计，不代表兼容性或部署。
   * @throws 本层不定义业务错误；认证和下游查询失败由已有全局 Guard/异常映射处理。
   */
  @Get()
  list(
    @Param("runId", new ZodValidationPipe(idSchema)) runId: string,
  ): Promise<ArtifactView[]> {
    return this.artifacts.listByRun(runId);
  }
}
