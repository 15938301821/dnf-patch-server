/**
 * @fileoverview 装配 Image Attempt 路由、业务编排和持久化依赖，并向其他模块导出 ImageService；不承载图片生成或业务逻辑。
 * @module modules/image/module
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：AppModule 导入本 Nest Module；ImageController 调用 ImageService，后者使用 ImageRepository 与 RunModule 导出的 RunService。
 * 输入输出：Nest 依赖注入创建 Controller 和 Provider；对外仅导出 ImageService，不提供数据库连接或图片字节。
 * 副作用：仅在应用启动期注册依赖关系，不读写 Image Attempt、对象存储或模型服务。
 * 安全边界：业务归属校验和状态规则仍在 Service/Repository 层完成，Module 不能绕过它们。
 */
import { Module } from "@nestjs/common";
import { RunModule } from "../run/run.module.js";
import { ImageController } from "./image.controller.js";
import { ImageRepository } from "./image.repository.js";
import { ImageService } from "./image.service.js";

@Module({
  imports: [RunModule],
  controllers: [ImageController],
  providers: [ImageRepository, ImageService],
  exports: [ImageService],
})
/**
 * Image 领域的 Nest 依赖装配器。
 *
 * 被根模块加载后注册 Image Attempt 的 HTTP 入口，并将 ImageService 作为跨模块公开能力；不直接处理请求、事务或持久化规则。
 */
export class ImageModule {}
