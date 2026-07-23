/**
 * @fileoverview 将 Nest 请求生命周期中的异常映射为统一 JSON 错误 ViewModel；不执行业务补偿、
 * 事务回滚或日志持久化，也不把未知异常的 message/stack 返回客户端。
 * @module common/http
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：main.ts 将 HttpExceptionFilter 注册为全局 Filter（Controller 返回或抛错后的响应
 * 适配层）；上游是 Controller/Guard/Pipe/Service 异常，下游是 FastifyReply。输入为 unknown 异常
 * 与 HTTP 上下文，输出为版本化错误响应。副作用是结束当前 HTTP 响应，不写数据库或事件。
 * 安全边界：未知 500 只返回通用消息；已知 HttpException 的结构化 response 会作为 details
 * 返回，因此其生产方不得放入 token、凭据、数据库原始对象、绝对路径或模型原始响应。
 */
import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

/** 返回浏览器或 Worker 的稳定错误 ViewModel；不是原始异常或日志记录。 */
interface ErrorResponse {
  /** 错误响应协议版本，供客户端显式演进解析。 */
  schemaVersion: 1;
  /** 实际发送的 HTTP 状态码。 */
  statusCode: number;
  /** 调用方可分支处理的稳定业务码；缺失时回退为 `HTTP_<status>`。 */
  code: string;
  /** 面向调用方的中文安全消息；未知 500 不包含内部 exception.message。 */
  message: string;
  /** 当前请求 URL；可能含 query，调用方不得把秘密放入查询参数。 */
  path: string;
  /** 服务生成响应时的 UTC ISO 时间，不代表数据库事务提交时间。 */
  timestampUtc: string;
  /** 仅承载受信 HttpException 生产方提供的结构化信息，不能放入敏感或原始 Provider 数据。 */
  details?: unknown;
}

/**
 * 捕获所有 HTTP 异常并统一响应结构。
 *
 * Filter 位于 Controller、Guard（Controller 前认证门禁）与 Pipe 执行之后；它只映射失败，不能
 * 替代领域所有权检查或 transaction（要么全部提交、要么全部回滚的数据库操作）边界。
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  /**
   * 将当前异常写入 Fastify 响应，并对未知 500 隐藏内部消息。
   *
   * @param exception Nest 请求链抛出的未知值；只有 HttpException 的公开 response 可被读取。
   * @param host Nest 提供的当前执行上下文，用于取得 Fastify 请求与响应对象。
   * @returns 无返回值；方法通过 FastifyReply 完成响应发送。
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    // 步骤 1：只从 HTTP adapter 上下文读取当前请求/响应，不依赖 Express 专有对象。
    const context = host.switchToHttp();
    const request = context.getRequest<FastifyRequest>();
    const response = context.getResponse<FastifyReply>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    // 步骤 2：已知 HttpException 保留其稳定公开 payload；未知异常不读取内部对象作为详情。
    const payload =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const details = typeof payload === "object" ? payload : undefined;
    const message =
      status === 500 ? "服务端处理失败。" : extractMessage(payload, exception);
    // 步骤 3：构造版本化 ViewModel 后一次发送；此处不记录异常对象，避免日志意外泄密。
    const body: ErrorResponse = {
      schemaVersion: 1,
      statusCode: status,
      code: extractCode(payload, status),
      message,
      path: request.url,
      timestampUtc: new Date().toISOString(),
      ...(details ? { details } : {}),
    };
    void response.status(status).send(body);
  }
}

/**
 * 从受信 HTTP 异常 payload 提取客户端消息。
 * @param payload HttpException.getResponse() 的公开值，生产方必须已完成脱敏。
 * @param exception 原始异常，仅非 500 且没有 payload 消息时作为兼容回退。
 * @returns 字符串消息；数组消息使用分号连接。
 */
function extractMessage(payload: unknown, exception: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = payload.message;
    return Array.isArray(message) ? message.join("; ") : String(message);
  }
  return exception instanceof Error ? exception.message : "请求处理失败。";
}

/**
 * @param payload 已知 HttpException 的公开响应；可包含稳定 `code` 字段。
 * @param status 将发送的 HTTP 状态码。
 * @returns payload code 的字符串形式，缺失时返回可预测的 `HTTP_<status>`。
 */
function extractCode(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "code" in payload) {
    return String(payload.code);
  }
  return `HTTP_${String(status)}`;
}
