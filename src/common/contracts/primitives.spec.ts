/**
 * @fileoverview 验证跨模块基础契约的路径安全边界，不覆盖领域 DTO 规则。
 * @module common/contracts
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan N/A - 用户直接要求按仓库规则分析并修复代码。
 */
import { describe, expect, it } from "vitest";

import { repositoryRelativePathSchema } from "./primitives.js";

describe("repositoryRelativePathSchema", () => {
  it.each([
    "/root/file.bin",
    "C:\\root\\file.bin",
    "\\root\\file.bin",
    "\\\\server\\share\\file.bin",
  ])("拒绝根路径 %s", (value) => {
    expect(repositoryRelativePathSchema.safeParse(value).success).toBe(false);
  });

  it.each(["artifacts/file.bin", "artifacts\\file.bin"])(
    "接受仓库相对路径 %s",
    (value) => {
      expect(repositoryRelativePathSchema.safeParse(value).success).toBe(true);
    },
  );
});
