import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../common/db/database.service.js";

export interface HealthView {
  schemaVersion: 1;
  status: "ok" | "degraded";
  service: "dnf-patch-server";
  version: string;
  database: "available" | "unavailable";
  checkedAtUtc: string;
}

@Injectable()
export class HealthService {
  constructor(private readonly database: DatabaseService) {}

  async check(): Promise<HealthView> {
    let database: HealthView["database"] = "available";
    try {
      await this.database.ping();
    } catch {
      database = "unavailable";
    }
    return {
      schemaVersion: 1,
      status: database === "available" ? "ok" : "degraded",
      service: "dnf-patch-server",
      version: "0.1.0",
      database,
      checkedAtUtc: new Date().toISOString(),
    };
  }
}
