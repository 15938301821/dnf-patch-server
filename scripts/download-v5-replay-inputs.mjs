/**
 * @fileoverview 短生命周期的本机诊断脚本：按终局 Run 已冻结的 Artifact ID，从 MySQL 读取
 * 对象定位与长度/SHA，再从本机 MinIO 下载到系统临时目录。它不修改数据库、对象存储或 Run。
 * 调用链仅为人工诊断 -> MySQL 只读查询 -> MinIO GetObject -> 本地逐字节复核；任一缺失、长度或
 * SHA 漂移都会失败关闭。MinIO 凭据只从进程环境读取，不写入文件、参数或输出。
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";

const artifactIds = [
  "3ef157bc-5262-4410-87f5-0b8c287afb1e",
  "ee124a8b-5e78-443e-ad7b-d334f963e988",
  "a9ab55af-9bdc-4714-824d-b30feca04e77",
  "4d754c06-48d7-4feb-869a-58abc04e025a",
  "4454d3e8-78f1-45ab-a238-c022a6f5382e",
];

const environment = await readDotEnv(".env");
const outputDirectory = join(tmpdir(), "dnf-v5-replay-illusionslash");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory);

const connection = await mysql.createConnection(
  required(environment, "DATABASE_URL"),
);
let artifacts;
try {
  [artifacts] = await connection.query(
    `SELECT id, storage_key AS storageKey, media_type AS mediaType,
            byte_length AS byteLength, sha256
       FROM artifacts
      WHERE id IN (?)`,
    [artifactIds],
  );
} finally {
  await connection.end();
}
if (artifacts.length !== artifactIds.length) {
  throw new Error("REPLAY_ARTIFACT_EVIDENCE_INCOMPLETE");
}

const client = new S3Client({
  endpoint: required(process.env, "OBJECT_STORAGE_ENDPOINT"),
  region: required(process.env, "OBJECT_STORAGE_REGION"),
  forcePathStyle:
    required(process.env, "OBJECT_STORAGE_FORCE_PATH_STYLE") === "true",
  credentials: {
    accessKeyId: required(process.env, "OBJECT_STORAGE_ACCESS_KEY"),
    secretAccessKey: required(process.env, "OBJECT_STORAGE_SECRET_KEY"),
  },
});

const results = [];
for (const artifact of artifacts) {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: required(process.env, "OBJECT_STORAGE_BUCKET"),
      Key: artifact.storageKey,
    }),
  );
  if (!response.Body) throw new Error("REPLAY_ARTIFACT_BODY_MISSING");
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  if (
    bytes.byteLength !== artifact.byteLength ||
    sha256 !== artifact.sha256.toUpperCase()
  ) {
    throw new Error("REPLAY_ARTIFACT_CONTENT_MISMATCH");
  }
  const extension =
    artifact.mediaType === "application/zip"
      ? ".zip"
      : artifact.mediaType === "application/json"
        ? ".json"
        : ".png";
  await writeFile(join(outputDirectory, `${artifact.id}${extension}`), bytes, {
    flag: "wx",
  });
  results.push({
    id: artifact.id,
    byteLength: bytes.byteLength,
    sha256,
  });
}

console.log(JSON.stringify({ outputDirectory, artifacts: results }, null, 2));

async function readDotEnv(filePath) {
  const values = {};
  for (const rawLine of (await readFile(filePath, "utf8")).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`REPLAY_ENVIRONMENT_REQUIRED_${name}`);
  }
  return value;
}
