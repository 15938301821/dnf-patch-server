/**
 * @fileoverview 签发和验证浏览器访问/刷新会话令牌；不保存凭据，也不回显共享令牌。
 * @module common/security/browser-session
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端远程 API 会话需求）
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type BrowserSessionKind = "access" | "refresh";

export interface BrowserSessionPayload {
  kind: BrowserSessionKind;
  subject: string;
  displayName: string;
  expiresAt: number;
  nonce: string;
}

export interface BrowserSessionPrincipal {
  username: string;
  displayName: string;
}

export interface BrowserSessionUser extends BrowserSessionPrincipal {
  id: string;
}

export function createBrowserSessionToken(
  secret: string,
  user: BrowserSessionPrincipal,
  kind: BrowserSessionKind,
  ttlSeconds: number,
): string {
  const payload: BrowserSessionPayload = {
    kind,
    subject: user.username,
    displayName: user.displayName,
    expiresAt: Math.floor(Date.now() / 1_000) + ttlSeconds,
    nonce: randomUUID(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `session.${encodedPayload}.${sign(secret, encodedPayload)}`;
}

export function verifyBrowserSessionToken(
  secret: string,
  token: string,
  kind: BrowserSessionKind,
): BrowserSessionPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "session") return undefined;
  const encodedPayload = parts[1];
  const signature = parts[2];
  if (!encodedPayload || !signature) return undefined;
  if (!secureEqual(signature, sign(secret, encodedPayload))) return undefined;
  const parsed = parsePayload(encodedPayload);
  if (!parsed || parsed.kind !== kind) return undefined;
  if (parsed.expiresAt <= Math.floor(Date.now() / 1_000)) return undefined;
  return parsed;
}

export function userFromSession(
  payload: BrowserSessionPayload,
): BrowserSessionUser {
  return {
    id: `browser.${stableUserId(payload.subject)}`,
    username: payload.subject,
    displayName: payload.displayName,
  };
}

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
      !("displayName" in parsed) ||
      !("expiresAt" in parsed) ||
      !("nonce" in parsed)
    ) {
      return undefined;
    }
    const payload = parsed as BrowserSessionPayload;
    return typeof payload.subject === "string" &&
      typeof payload.displayName === "string" &&
      typeof payload.expiresAt === "number" &&
      typeof payload.nonce === "string"
      ? payload
      : undefined;
  } catch {
    return undefined;
  }
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function stableUserId(subject: string): string {
  return createHmac("sha256", "dnf-patch-browser-user")
    .update(subject, "utf8")
    .digest("hex")
    .slice(0, 16);
}
