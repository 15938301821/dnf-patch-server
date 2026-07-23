/**
 * @fileoverview 签发和验证浏览器访问/刷新会话令牌；不保存凭据，也不回显共享令牌。
 * @module common/security/browser-session
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Auth Service 在登录/刷新后调用 createBrowserSessionToken；ApiAuthGuard 与认证
 * Controller 调用 verifyBrowserSessionToken，随后 userFromSession 形成认证上下文。输入为稳定用户
 * 身份、会话种类、期限和环境签名秘密，输出为签名 token 或用户视图。副作用仅生成随机 nonce。
 * 安全边界：token 使用 HMAC-SHA256 保证完整性但正文可解码，绝不能放入密钥；验签、种类和过期
 * 任一失败均返回 undefined。会话认证不替代数据库用户状态及资源所有权检查。
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/** 浏览器会话用途；access 进入业务 API，refresh 只能换取新会话。 */
export type BrowserSessionKind = "access" | "refresh";

/** 签名 token 内的有界载荷，由服务端生产并由 Guard/认证 Controller 消费。 */
export interface BrowserSessionPayload {
  /** token 用途；验证方必须传入预期种类，禁止 refresh 冒充 access。 */
  kind: BrowserSessionKind;
  /** 持久化用户 UUID，是后续所有权检查的稳定主体，不使用 displayName 代替。 */
  subject: string;
  /** 签发时用户名快照，仅用于响应展示，不能单独作为租户边界。 */
  username: string;
  /** 签发时显示名快照，可变且不参与资源归属判断。 */
  displayName: string;
  /** Unix 秒级绝对到期时间；等于当前秒时已失效。 */
  expiresAt: number;
  /** 每次签发生成的 UUID，避免相同用户和期限得到完全相同 token。 */
  nonce: string;
}

/** token 签发输入的最小稳定用户结构，生产方应来自已认证数据库用户。 */
export interface BrowserSessionPrincipal {
  /** 持久化用户 UUID，写入 payload.subject。 */
  id: string;
  /** 已验证用户名快照，不作为签名秘密。 */
  username: string;
  /** 可展示名称快照，不承担授权语义。 */
  displayName: string;
}

/** API 认证上下文使用的用户 ViewModel；从已验签 payload 映射，不包含会话秘密。 */
export interface BrowserSessionUser extends BrowserSessionPrincipal {
  /** 来自 payload.subject 的稳定用户 ID，供 Service 执行所有权检查。 */
  id: string;
}

/**
 * 签发一个带用途和过期时间的浏览器会话 token。
 * @param secret environmentSchema 校验的会话签名秘密，只在进程内存中使用。
 * @param user 已由认证 Service 从数据库确认的稳定用户主体。
 * @param kind access 或 refresh，用于阻止跨用途重放。
 * @param ttlSeconds 调用方固定的有效期秒数；函数据当前时钟计算绝对过期时间。
 * @returns `session.<payload>.<signature>` 字符串；正文可解码但签名不可伪造，不含用户密码或密钥。
 */
export function createBrowserSessionToken(
  secret: string,
  user: BrowserSessionPrincipal,
  kind: BrowserSessionKind,
  ttlSeconds: number,
): string {
  // 步骤 1：只写入认证所需的稳定主体与展示快照，并为每次签发生成独立 nonce。
  const payload: BrowserSessionPayload = {
    kind,
    subject: user.id,
    username: user.username,
    displayName: user.displayName,
    expiresAt: Math.floor(Date.now() / 1_000) + ttlSeconds,
    nonce: randomUUID(),
  };
  // 步骤 2：先固定 UTF-8/base64url 表示，再对精确编码串签名，避免解析后重编码差异。
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `session.${encodedPayload}.${sign(secret, encodedPayload)}`;
}

/**
 * 验证会话结构、HMAC 签名、用途和过期时间。
 * @param secret 与签发时同一环境会话秘密，不得来自请求。
 * @param token Authorization Bearer 或刷新 DTO 提供的未信任字符串。
 * @param kind 当前入口允许的唯一会话用途。
 * @returns 验证成功的有界 payload；任何格式、签名、用途、字段或期限失败都返回 undefined。
 */
export function verifyBrowserSessionToken(
  secret: string,
  token: string,
  kind: BrowserSessionKind,
): BrowserSessionPayload | undefined {
  // 步骤 1：固定三段格式并先验签；未通过前不信任 payload 中的身份字段。
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "session") return undefined;
  const encodedPayload = parts[1];
  const signature = parts[2];
  if (!encodedPayload || !signature) return undefined;
  if (!secureEqual(signature, sign(secret, encodedPayload))) return undefined;
  // 步骤 2：验签后仍执行字段预算、用途与期限校验，拒绝合法签名下的错误会话类型。
  const parsed = parsePayload(encodedPayload);
  if (!parsed || parsed.kind !== kind) return undefined;
  if (parsed.expiresAt <= Math.floor(Date.now() / 1_000)) return undefined;
  return parsed;
}

/**
 * @param payload 已通过签名、字段、用途和期限校验的会话 payload。
 * @returns 供 Controller/Service 使用的脱敏用户认证上下文；不包含 nonce、期限或签名。
 */
export function userFromSession(
  payload: BrowserSessionPayload,
): BrowserSessionUser {
  return {
    id: payload.subject,
    username: payload.username,
    displayName: payload.displayName,
  };
}

/**
 * 解码并按显式字段/长度预算校验 token 正文。
 * @param value 已验签的 base64url payload；仍按 unknown 处理 JSON 结果。
 * @returns 满足会话结构的 payload，解码、JSON 或字段校验失败时返回 undefined。
 */
function parsePayload(value: string): BrowserSessionPayload | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("kind" in parsed) ||
      !("subject" in parsed) ||
      !("username" in parsed) ||
      !("displayName" in parsed) ||
      !("expiresAt" in parsed) ||
      !("nonce" in parsed)
    ) {
      return undefined;
    }
    const payload = parsed as BrowserSessionPayload;
    return typeof payload.subject === "string" &&
      payload.subject.length <= 64 &&
      typeof payload.username === "string" &&
      payload.username.length <= 64 &&
      typeof payload.displayName === "string" &&
      payload.displayName.length <= 160 &&
      typeof payload.expiresAt === "number" &&
      typeof payload.nonce === "string"
      ? payload
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param secret 仅在内存中的浏览器会话 HMAC 秘密。
 * @param payload 已固定编码的 token payload。
 * @returns SHA-256 HMAC 的 base64url 表示，不返回或记录 secret。
 */
function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
}

/**
 * @param left 请求携带的候选签名。
 * @param right 服务端重新计算的预期签名。
 * @returns 长度相同且恒定时间比较匹配时为 true；长度不同直接拒绝以满足 API 前置条件。
 */
function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
