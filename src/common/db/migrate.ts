import "reflect-metadata";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createPool } from "mysql2/promise";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for migration.");
}

const pool = createPool({
  uri: databaseUrl,
  connectionLimit: 1,
  timezone: "Z",
});
try {
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
} finally {
  await pool.end();
}
