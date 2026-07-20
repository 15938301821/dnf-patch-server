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
export class RunGateway implements OnGatewayInit {
  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly runs: RunService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

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

  publishRunEvent(runId: string, event: RunEventView): void {
    this.server.to(`run:${runId}`).emit("run:event", event);
  }
}

const socketAuthSchema = z.object({ token: z.string().min(1) }).strict();
