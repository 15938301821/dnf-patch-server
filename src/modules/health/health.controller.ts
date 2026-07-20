import { Controller, Get } from "@nestjs/common";
import { HealthService, type HealthView } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async getHealth(): Promise<HealthView> {
    return this.health.check();
  }
}
