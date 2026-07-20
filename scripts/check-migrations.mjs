import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const migrationRoot = resolve("drizzle");
const journalPath = resolve(migrationRoot, "meta", "_journal.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
if (!Array.isArray(journal.entries)) {
  throw new Error("Drizzle migration journal has no entries array.");
}
const sqlFiles = (await readdir(migrationRoot))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
  .sort();
const journalFiles = journal.entries.map((entry) => `${entry.tag}.sql`).sort();
if (JSON.stringify(sqlFiles) !== JSON.stringify(journalFiles)) {
  throw new Error(
    `Migration SQL and journal differ: ${JSON.stringify({ sqlFiles, journalFiles })}`,
  );
}

let foreignKeyCount = 0;
for (const file of sqlFiles) {
  const sql = await readFile(resolve(migrationRoot, file), "utf8");
  if (/ON\s+DELETE\s+(?:CASCADE|SET\s+NULL)/iu.test(sql)) {
    throw new Error(`Migration contains destructive delete behavior: ${file}`);
  }
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (!/ADD\s+CONSTRAINT[\s\S]*FOREIGN\s+KEY/iu.test(statement)) {
      continue;
    }
    foreignKeyCount += 1;
    if (!/ON\s+DELETE\s+restrict/iu.test(statement)) {
      throw new Error(`Foreign key is not delete-restrictive in ${file}.`);
    }
  }
}
if (foreignKeyCount === 0) {
  throw new Error("No database foreign keys were found in migrations.");
}
process.stdout.write(
  `${JSON.stringify({ status: "passed", migrationCount: sqlFiles.length, journalEntryCount: journalFiles.length, foreignKeyCount }, null, 2)}\n`,
);
