import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiAuthGuard } from "./api-auth.guard.js";
import { ClientTokenGuard } from "./client-token.guard.js";
import { WorkerTokenGuard } from "./worker-token.guard.js";

@Global()
@Module({
  providers: [
    ClientTokenGuard,
    WorkerTokenGuard,
    ApiAuthGuard,
    { provide: APP_GUARD, useExisting: ApiAuthGuard },
  ],
  exports: [ClientTokenGuard, WorkerTokenGuard],
})
export class SecurityModule {}
