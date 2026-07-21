import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Drizzle commands.");
}

export default defineConfig({
  dialect: "mysql",
  schema: ["./dist/common/db/schema.js", "./dist/common/db/studio-schema.js"],
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
