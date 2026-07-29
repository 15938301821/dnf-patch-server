/**
 * @fileoverview 为 owner-scoped 制作任务中的固定技能预览签发短期 Artifact 下载授权。
 *
 * 调用关系：PatchTaskService 的浏览器方法调用本模块；Repository 先按任务、技能、用户和固定角色
 * 恢复唯一图片，Artifact Service 再复核同 Run 归属并签名。输入不包含 Artifact ID 或对象 key，
 * 输出为脱敏 PNG 元数据与短期 URL。副作用仅为只读查询和对象存储签名，不读取图片正文。
 * 安全边界：证据缺失与跨用户访问共享低信息 404，且失败后不得调用签名层。
 */
import { NotFoundException } from "@nestjs/common";
import type { ArtifactService } from "../artifact/artifact.service.js";
import type {
  PatchTaskReferenceImageDownloadView,
  PatchTaskReferenceImageView,
  PatchTaskSkillPreviewDownloadView,
  PatchTaskSkillPreviewRole,
  PatchTaskSkillPreviewView,
} from "./patch-task.contracts.js";

/** 预览授权只依赖两个固定语义查询，不能退化为通用 Artifact 查找。 */
export interface PatchTaskPreviewRepositoryPort {
  findReferenceImage(
    runId: string,
    skillId: string,
    ownerUserId: string,
  ): Promise<PatchTaskReferenceImageView | undefined>;
  findSkillPreview(
    runId: string,
    skillId: string,
    role: PatchTaskSkillPreviewRole,
    ownerUserId: string,
  ): Promise<PatchTaskSkillPreviewView | undefined>;
}

/** 签名端口仍由 Artifact 领域执行 Run 归属复核，本模块不直接接触对象存储 SDK。 */
export interface PatchTaskPreviewArtifactDownloadPort {
  authorizeRunArtifactDownload(
    runId: string,
    artifactId: string,
    downloadName: string,
  ): ReturnType<ArtifactService["authorizeRunArtifactDownload"]>;
}

/**
 * 为旧参考图端点签发兼容授权。
 * @returns 当前 attempt 现行参考图阶段的脱敏元数据和短期 URL。
 */
export async function authorizePatchTaskReferenceImageDownload(
  patchTasks: PatchTaskPreviewRepositoryPort,
  artifacts: PatchTaskPreviewArtifactDownloadPort,
  runId: string,
  skillId: string,
  ownerUserId: string,
): Promise<PatchTaskReferenceImageDownloadView> {
  const image = await patchTasks.findReferenceImage(
    runId,
    skillId,
    ownerUserId,
  );
  if (!image) {
    throw new NotFoundException({
      code: "PATCH_TASK_REFERENCE_IMAGE_NOT_READY",
      message: "该技能的模型参考图尚未生成或当前用户无权查看。",
    });
  }
  const authorization = await artifacts.authorizeRunArtifactDownload(
    runId,
    image.artifactId,
    image.artifactName,
  );
  return {
    ...image,
    downloadUrl: authorization.downloadUrl,
    expiresAtUtc: authorization.expiresAtUtc,
  };
}

/**
 * 为源帧、模型参考图或 Aseprite 结果固定角色签发短期授权。
 * @returns 当前 attempt 的角色元数据和短期 URL；不证明兼容、部署或全技能覆盖。
 */
export async function authorizePatchTaskSkillPreviewDownload(
  patchTasks: PatchTaskPreviewRepositoryPort,
  artifacts: PatchTaskPreviewArtifactDownloadPort,
  runId: string,
  skillId: string,
  role: PatchTaskSkillPreviewRole,
  ownerUserId: string,
): Promise<PatchTaskSkillPreviewDownloadView> {
  const image = await patchTasks.findSkillPreview(
    runId,
    skillId,
    role,
    ownerUserId,
  );
  if (!image) {
    throw new NotFoundException({
      code: "PATCH_TASK_SKILL_PREVIEW_NOT_READY",
      message: "该技能预览尚未生成或当前用户无权查看。",
    });
  }
  const authorization = await artifacts.authorizeRunArtifactDownload(
    runId,
    image.artifactId,
    image.artifactName,
  );
  return {
    ...image,
    downloadUrl: authorization.downloadUrl,
    expiresAtUtc: authorization.expiresAtUtc,
  };
}
