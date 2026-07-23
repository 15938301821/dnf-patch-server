/**
 * @fileoverview 提供 Run 事件的受共享客户端令牌保护的 Socket.IO 订阅和提交后广播；不作为权威状态来源，
 * 不创建 Run/Job、不处理 Worker token，也不接收模型/工具/资源数据。
 * @module modules/run/gateway
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Nest 初始化 Gateway 后调用 afterInit 安装握手 middleware；客户端发送 `run:subscribe`，
 * Gateway 用 RunService 读取持久化 Run/事件快照后加入房间；RunOutboxDispatcherService 仅在数据库提交后
 * 调用 publishRunEvent 推送新增事件。
 * 输入输出：输入是 socket handshake token 和订阅 DTO；输出是订阅确认、一次 snapshot 与后续 event，
 * 不返回数据库连接、Worker lease、Job payload、模型凭据或 Artifact 内容。
 * 副作用：订阅会加入 Socket.IO 房间并发送 snapshot；publishRunEvent 发出内存通知，但不会持久化事件。
 * 安全边界：WebSocket 不可成为唯一事实源，客户端必须用 sequence 从 REST/Service 事件流恢复；握手 token
 * 使用常量时间比较，认证失败不加入任何房间。共享 token 认证不替代领域资源所有权检查的未来实现。
 */
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { ConfigService } from "@nestjs/config";
import type { Server, Socket } from "socket.io";
import { z } from "zod";
import { secureEqual } from "../../common/security/client-token.guard.js";
import type { Environment } from "../../config/environment.js";
import {
  runSubscriptionSchema,
  type RunEventView,
  type RunSubscription,
} from "./run.contracts.js";
import { RunService } from "./run.service.js";

@WebSocketGateway({ namespace: "/runs", cors: false })
/** Run 事件通知适配层，只广播已提交的权威事件，不承担状态机和重放存储。 */
export class RunGateway implements OnGatewayInit {
  /** Socket.IO Server 由 Nest 注入，仅用于向已认证房间发布提交后的事件。 */
  @WebSocketServer()
  private server!: Server;

  /**
   * @param runs Run 公开 Service，用于订阅前验证 Run 存在并读取权威快照。
   * @param config 已校验环境配置，提供 CLIENT_SHARED_TOKEN，不将值写入事件或日志。
   */
  constructor(
    private readonly runs: RunService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  /**
   * 在 Socket.IO Server 上安装每连接一次的共享客户端令牌验证。
   * @param server Nest 创建的 namespace Server。
   * @sideEffect 注册 middleware；认证失败的 socket 收到 CLIENT_AUTH_FAILED，无法订阅任何 Run 房间。
   * @remarks 该检查只保护此 WebSocket namespace，不替代 REST Guard、Run 归属或用户所有权校验。
   */
  afterInit(server: Server): void {
    const expected = this.config.getOrThrow("CLIENT_SHARED_TOKEN", {
      infer: true,
    });
    server.use((socket, next) => {
      const parsed = socketAuthSchema.safeParse(socket.handshake.auth);
      if (!parsed.success || !secureEqual(parsed.data.token, expected)) {
        next(new Error("CLIENT_AUTH_FAILED"));
        return;
      }
      next();
    });
  }

  /**
   * 订阅一个 Run 房间并先发送可从数据库恢复的 snapshot。
   *
   * 步骤 1：严格解析消息；步骤 2：通过 RunService 确认 Run 存在；步骤 3：加入仅含该 runId 的房间；
   * 步骤 4：从 afterSequence 开始读取有界权威事件并发送 snapshot。连接抖动后客户端必须重新订阅或用
   * REST 事件端点补齐，而不能假设所有广播必达。
   *
   * @param socket 已通过握手 middleware 的 Socket.IO 连接。
   * @param payload 不可信消息体，先作为 unknown 解析。
   * @returns 订阅确认；不返回 Job、lease、Worker 或 Artifact 细节。
   * @throws Zod 或 RunService 的错误，当 DTO 无效或 Run 不存在时不会加入目标房间。
   */
  @SubscribeMessage("run:subscribe")
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: unknown,
  ): Promise<{ status: "subscribed"; runId: string }> {
    const input: RunSubscription = runSubscriptionSchema.parse(payload);
    const run = await this.runs.get(input.runId);
    await socket.join(`run:${run.id}`);
    const events = await this.runs.events(run.id, {
      afterSequence: input.afterSequence,
      limit: 200,
    });
    socket.emit("run:snapshot", { run, events });
    return { status: "subscribed", runId: run.id };
  }

  /**
   * 向一个 Run 的订阅房间广播已提交的权威事件。
   * @param runId 事件所属 Run，与 event.runId 应由 outbox schema/dispatcher 保证一致。
   * @param event 已提交且已解析的 RunEventView。
   * @sideEffect 发送 Socket.IO 通知；不会持久化、重试或补偿失败客户端，恢复由 sequence 事件流负责。
   */
  publishRunEvent(runId: string, event: RunEventView): void {
    this.server.to(`run:${runId}`).emit("run:event", event);
  }
}

/** 握手 auth 的最小严格形状，只允许令牌，不接受任意订阅参数或客户端声明的用户身份。 */
const socketAuthSchema = z.object({ token: z.string().min(1) }).strict();
