/**
 * @fileoverview 使用固定版本的 scrypt 参数生成和验证用户密码摘要；不记录或持久化明文密码。
 * @module auth
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应前端账号密码登录与用户模型配置归属）
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const derivedKeyLength = 32;
const scryptOptions = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface PasswordDigest {
  scheme: "scrypt-v1";
  salt: string;
  hash: string;
}

/** 生成带随机盐的 scrypt 摘要，调用方只持久化返回值。 */
export async function hashPassword(password: string): Promise<PasswordDigest> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return {
    scheme: "scrypt-v1",
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url"),
  };
}

/** 验证 scrypt-v1 摘要；未知方案或损坏编码统一返回 false。 */
export async function verifyPassword(
  password: string,
  digest: PasswordDigest,
): Promise<boolean> {
  try {
    const expected = Buffer.from(digest.hash, "base64url");
    const salt = Buffer.from(digest.salt, "base64url");
    if (expected.length !== derivedKeyLength || salt.length !== 16) {
      return false;
    }
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, derivedKeyLength, scryptOptions, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}
