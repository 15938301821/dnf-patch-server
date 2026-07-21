/**
 * @fileoverview 定义浏览器登录会话 DTO；不包含密码存储、用户注册或共享令牌回显。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { z } from "zod";

export const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(1_000),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
}

export interface AuthSession {
  accessToken: string;
  user: SessionUser;
}
