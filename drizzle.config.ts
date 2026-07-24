import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Drizzle commands.");
}

export default defineConfig({
  dialect: "mysql",
  schema: [
    "./dist/common/db/schema.js",
    "./dist/common/db/artifact-schema.js",
    "./dist/common/db/browser-session-schema.js",
    "./dist/common/db/studio-schema.js",
    "./dist/common/db/profession-model-execution-schema.js",
    "./dist/common/db/profession-source-schema.js",
    "./dist/common/db/style-package-schema.js",
  ],
  out: "./drizzle",
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
