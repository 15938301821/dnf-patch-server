/**
 * @fileoverview 定义 Artifact 上传生命周期配置令牌；不保存对象存储凭据。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */

export interface ArtifactUploadOptions {
  maxRunBytes: number;
  sessionTtlSeconds: number;
}

export const ARTIFACT_UPLOAD_OPTIONS = Symbol("ARTIFACT_UPLOAD_OPTIONS");
