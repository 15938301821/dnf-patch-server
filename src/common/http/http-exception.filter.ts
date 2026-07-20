import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";

interface ErrorResponse {
  schemaVersion: 1;
  statusCode: number;
  code: string;
  message: string;
  path: string;
  timestampUtc: string;
  details?: unknown;
}

/** 统一错误格式且不返回堆栈、环境变量或数据库驱动原始对象。 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const details = typeof payload === "object" ? payload : undefined;
    const message =
      status === 500 ? "服务端处理失败。" : extractMessage(payload, exception);
    const body: ErrorResponse = {
      schemaVersion: 1,
      statusCode: status,
      code: extractCode(payload, status),
      message,
      path: request.url,
      timestampUtc: new Date().toISOString(),
      ...(details ? { details } : {}),
    };
    response.status(status).json(body);
  }
}

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

function extractCode(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "code" in payload) {
    return String(payload.code);
  }
  return `HTTP_${String(status)}`;
}
