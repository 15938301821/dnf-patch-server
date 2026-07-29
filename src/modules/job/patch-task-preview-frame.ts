/**
 * @fileoverview 把 Worker 内部同帧 provenance 投影为浏览器可读取的预览帧 ViewModel。
 *
 * 流程位置：任务详情预览 Repository 完成 Artifact、会话和同代证据复核后调用本模块；输入仍含
 * decoded BGRA 摘要，输出只保留定位同一帧所需的非敏感字段。纯函数不查询数据库、不签发 URL，
 * 也不把内部像素摘要暴露给浏览器。
 */
import type { PatchTaskSkillPreviewFrameView } from "./patch-task.contracts.js";
import type { ProfessionSkillOutputProvenance } from "./profession-skill-output-evidence.js";

type SourcePreviewProvenance = Extract<
  ProfessionSkillOutputProvenance,
  {
    kind:
      | "profession-source-frame-preview-v1"
      | "profession-source-frame-preview-v2";
  }
>;

/** 仅公开帧位置与几何，隐藏 Worker 用于字节身份复核的 decoded BGRA SHA-256。 */
export function publicPatchTaskSkillPreviewFrame(
  frame: SourcePreviewProvenance["frame"],
): PatchTaskSkillPreviewFrameView {
  return {
    entryIndex: frame.entryIndex,
    frameIndex: frame.frameIndex,
    internalPath: frame.internalPath,
    width: frame.width,
    height: frame.height,
    canvasWidth: frame.canvasWidth,
    canvasHeight: frame.canvasHeight,
    x: frame.x,
    y: frame.y,
  };
}
