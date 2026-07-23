/**
 * @fileoverview 验证跨模块基础契约的路径安全边界，不覆盖领域 DTO 规则。
 * @module common/contracts
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接向路径 schema 提交字符串，不经过 HTTP DTO 或文件系统。输入为平台风格
 * 路径样本，输出为 Zod 解析结果；无 I/O 或 Mock。安全边界：覆盖根路径、盘符、UNC 与普通
 * 相对引用，但不证明对象存在、归属正确或操作系统权限安全。
 */
import { describe, expect, it } from "vitest";

import { repositoryRelativePathSchema } from "./primitives.js";

describe("repositoryRelativePathSchema", () => {
  // 防止外部载荷把数据库中的相对对象引用替换为主机绝对路径或网络共享路径。
  it.each([
    "/root/file.bin",
    "C:\\root\\file.bin",
    "\\root\\file.bin",
    "\\\\server\\share\\file.bin",
  ])("拒绝根路径 %s", (value) => {
    expect(repositoryRelativePathSchema.safeParse(value).success).toBe(false);
  });

  // 两种分隔符仅作为协议表示被接受；测试不访问或创建对应文件。
  it.each(["artifacts/file.bin", "artifacts\\file.bin"])(
    "接受仓库相对路径 %s",
    (value) => {
      expect(repositoryRelativePathSchema.safeParse(value).success).toBe(true);
    },
  );
});
