/**
 * @fileoverview 定义 Artifact 上传生命周期的依赖注入配置令牌；不保存对象存储凭据、URL、对象 key、
 * 数据库行或 Worker token，也不承担环境变量解析。
 * @module modules/artifact/tokens
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：ArtifactModule 从已验证的 Environment 读取配额与 TTL 后提供本令牌，ArtifactService 通过
 * 构造函数注入消费。输入是启动期受校验的数值配置，输出是不可伪造的 DI Symbol 与强类型选项。
 * 副作用：本文件没有数据库、对象存储、网络或事务副作用。
 * 安全边界：配额限制同一 Run 的待上传与 finalized 对象总量，TTL 限制短期 URL/会话生命周期；令牌不含
 * 凭据，不能替代对象存储授权、Run 归属、哈希复核或 Worker lease 校验。
 */

/**
 * ArtifactService 消费的上传生命周期配置。
 *
 * 值只由 ArtifactModule 从运行时环境提供；maxRunBytes 是单个 Run 可预留与持久化对象的上限，
 * sessionTtlSeconds 是服务端上传会话有效秒数。二者都不是客户端可提交的 DTO，且不代表实际存储余量。
 */
export interface ArtifactUploadOptions {
  maxRunBytes: number;
  sessionTtlSeconds: number;
}

/**
 * 注入 ArtifactUploadOptions 的唯一 Symbol。
 *
 * ArtifactModule 生产、ArtifactService 消费；它防止用字符串 token 意外注入未校验的配置，
 * 但不提供对象存储访问能力或任何秘密材料。
 */
export const ARTIFACT_UPLOAD_OPTIONS = Symbol("ARTIFACT_UPLOAD_OPTIONS");
