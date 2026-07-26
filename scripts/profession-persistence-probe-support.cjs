/**
 * @fileoverview 为 Profession 持久化探针提供参数校验、私有对象读取、ZIP manifest 解析和
 * MinIO/S3 往返诊断；不连接数据库、不调用模型、不执行 Worker 工具，也不修改业务 Artifact。
 * @module scripts/profession-persistence-probe-support
 * @author AI生成
 * @created 2026-07-26
 * @relatedPlan N/A - 用户直接要求继续整理本地诊断脚本
 *
 * 调用关系：probe-profession-engineer-persistence.cjs 在完成数据库只读查询后调用本模块；
 * 下游使用 Server 自身声明的 AWS SDK，并把已核验 ZIP 交给固定 manifest 模块。输入是命令行
 * 标识、进程环境和数据库返回的 Artifact 元数据，输出为不含对象键与凭据的诊断摘要。
 * 副作用：Artifact 检查只读私有对象；往返诊断创建一个随机 diagnostics 对象并在 finally
 * 中删除。安全边界：仅允许回环数据库/对象存储、所有对象读取受 512 MiB 硬预算约束、ZIP
 * manifest 必须严格校验，清理失败必须令诊断失败，任何错误都只能映射为稳定错误码。
 */
const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { createHash, randomUUID } = require("node:crypto");
const {
  ManifestProbeError,
  readZipManifest,
} = require("./profession-persistence-manifest.cjs");

const maxObjectBytes = 512 * 1024 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** 诊断内部稳定错误；边界只输出 code，不输出 SDK、数据库或路径原文。 */
class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
  }
}

/**
 * 在产生数据库或网络副作用前解析命令行标识。
 * @param {string[]} args `node` 已移除后的参数，只允许 jobId 与可选 runId。
 * @returns {{ jobId: string, runId: string | undefined }} 规范化 UUID。
 * @throws {ProbeError} 参数数量或 UUID 不合法时失败关闭。
 */
function parseProbeArguments(args) {
  if (args.length < 1 || args.length > 2 || !uuidPattern.test(args[0] ?? "")) {
    throw new ProbeError("JOB_ID_REQUIRED");
  }
  if (args[1] !== undefined && !uuidPattern.test(args[1])) {
    throw new ProbeError("RUN_ID_INVALID");
  }
  return { jobId: args[0].toLowerCase(), runId: args[1]?.toLowerCase() };
}

/**
 * 解析现有本地 Server 的数据库与对象存储配置；不会返回或记录凭据摘要。
 * @param {NodeJS.ProcessEnv} environment 当前进程环境，必须显式提供对象存储应用身份。
 * @returns {object} 仅供 mysql2 与 S3Client 使用的受限配置。
 * @throws {ProbeError} 缺失、非回环端点或格式错误时失败关闭。
 */
function parseProbeEnvironment(environment) {
  const databaseUrl = requireEnvironment(environment, "DATABASE_URL");
  const endpoint = requireEnvironment(environment, "OBJECT_STORAGE_ENDPOINT");
  const bucket = requireEnvironment(environment, "OBJECT_STORAGE_BUCKET");
  const accessKeyId = requireEnvironment(
    environment,
    "OBJECT_STORAGE_ACCESS_KEY",
  );
  const secretAccessKey = requireEnvironment(
    environment,
    "OBJECT_STORAGE_SECRET_KEY",
  );
  const database = parseLoopbackUrl(
    databaseUrl,
    ["mysql:"],
    "DATABASE_URL_INVALID",
  );
  const storageEndpoint = parseLoopbackUrl(
    endpoint,
    ["http:", "https:"],
    "OBJECT_STORAGE_ENDPOINT_INVALID",
  );
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket)) {
    throw new ProbeError("OBJECT_STORAGE_BUCKET_INVALID");
  }
  if (accessKeyId.length < 3 || accessKeyId.length > 128) {
    throw new ProbeError("OBJECT_STORAGE_CREDENTIALS_INVALID");
  }
  if (secretAccessKey.length < 32 || secretAccessKey.length > 256) {
    throw new ProbeError("OBJECT_STORAGE_CREDENTIALS_INVALID");
  }
  const forcePathStyleValue =
    environment.OBJECT_STORAGE_FORCE_PATH_STYLE ?? "true";
  if (forcePathStyleValue !== "true" && forcePathStyleValue !== "false") {
    throw new ProbeError("OBJECT_STORAGE_PATH_STYLE_INVALID");
  }
  const region = environment.OBJECT_STORAGE_REGION ?? "us-east-1";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u.test(region)) {
    throw new ProbeError("OBJECT_STORAGE_REGION_INVALID");
  }
  return {
    databaseUrl: database.toString(),
    storage: {
      endpoint: storageEndpoint.toString(),
      region,
      bucket,
      forcePathStyle: forcePathStyleValue === "true",
      credentials: { accessKeyId, secretAccessKey },
    },
  };
}

/** 使用已校验的回环端点与应用身份创建私有对象存储客户端。 */
function createStorageClient(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
  });
}

/**
 * 核对一个权威 Artifact 元数据对应的私有对象；只返回长度、哈希和媒体类型布尔结论。
 * @param {S3Client} storage 已绑定本地私有存储的客户端。
 * @param {object} config 已校验且包含 bucket 的对象存储配置。
 * @param {object | undefined} artifact 数据库 join 得到的 Artifact 元数据。
 * @returns {Promise<object>} 不暴露 storageKey 的对象证据摘要。
 */
async function inspectArtifactObject(storage, config, artifact) {
  if (!artifact) {
    return {
      checked: false,
      passed: false,
      errorCode: "ARTIFACT_METADATA_MISSING",
    };
  }
  try {
    const downloaded = await downloadObject(storage, config, artifact, false);
    const mediaTypeMatches = downloaded.mediaType === artifact.mediaType;
    return {
      checked: true,
      passed: mediaTypeMatches,
      byteLength: downloaded.byteLength,
      mediaTypeMatches,
      lengthMatches: true,
      shaMatches: true,
    };
  } catch (error) {
    return {
      checked: true,
      passed: false,
      errorCode: toStableErrorCode(error),
    };
  }
}

/** 下载并严格解析一个 passed 技能的 validation ZIP，输出有界领域摘要。 */
async function inspectPackageInput(storage, config, input) {
  try {
    const downloaded = await downloadObject(storage, config, input, true);
    const manifest = await readZipManifest(downloaded.bytes);
    return { skillId: input.skillId, passed: true, ...manifest };
  } catch (error) {
    return {
      skillId: input.skillId,
      passed: false,
      errorCode: toStableErrorCode(error),
    };
  }
}

/**
 * 写入、读回并删除随机诊断对象；删除失败必须覆盖成功结论，防止把垃圾对象留在私有 bucket。
 */
async function probeObjectStorageRoundTrip(storage, config) {
  const bytes = Buffer.from("dnf-patch-storage-diagnostic", "utf8");
  const sha256 = sha256Of(bytes);
  const storageKey = `diagnostics/${randomUUID()}`;
  let result;
  try {
    const put = await storage.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: storageKey,
        Body: bytes,
        ContentType: "application/octet-stream",
        ContentLength: bytes.byteLength,
        IfNoneMatch: "*",
        Metadata: { "dnf-sha256": sha256 },
      }),
    );
    const downloaded = await downloadObject(
      storage,
      config,
      {
        storageKey,
        byteLength: bytes.byteLength,
        sha256,
        mediaType: "application/octet-stream",
      },
      false,
    );
    result = {
      passed: downloaded.mediaType === "application/octet-stream",
      putStatus: put.$metadata?.httpStatusCode ?? null,
      mediaTypeMatches: downloaded.mediaType === "application/octet-stream",
      lengthMatches: true,
      shaMatches: true,
    };
  } catch (error) {
    result = { passed: false, errorCode: toStableErrorCode(error) };
  } finally {
    try {
      await storage.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: storageKey }),
      );
    } catch {
      result = { passed: false, errorCode: "DIAGNOSTIC_CLEANUP_FAILED" };
    }
  }
  return result;
}

/** 从 Factory JSON 中只提取 package 诊断需要的版本化契约摘要。 */
function summarizeFactoryConfig(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const encoded = Buffer.from(JSON.stringify(parsed), "utf8");
    if (
      encoded.byteLength > 1024 * 1024 ||
      !parsed ||
      typeof parsed !== "object"
    ) {
      throw new ProbeError("FACTORY_CONFIG_INVALID");
    }
    const contracts = Array.isArray(parsed.jobContracts)
      ? parsed.jobContracts.slice(0, 64).map((contract) => ({
          kind: typeof contract?.kind === "string" ? contract.kind : null,
          schemaVersion:
            typeof contract?.schemaVersion === "number"
              ? contract.schemaVersion
              : null,
          profileId:
            typeof contract?.profileId === "string"
              ? contract.profileId
              : typeof parsed.profileId === "string"
                ? parsed.profileId
                : null,
        }))
      : [];
    return {
      schemaVersion:
        typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : null,
      contracts,
    };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError("FACTORY_CONFIG_INVALID");
  }
}

/** 把内部异常映射为可公开到终端的稳定、脱敏错误码。 */
function toStableErrorCode(error) {
  if (error instanceof ProbeError) return error.code;
  if (error instanceof ManifestProbeError) return error.code;
  const name = typeof error?.name === "string" ? error.name : "";
  if (["NoSuchKey", "NotFound", "NoSuchBucket"].includes(name)) {
    return "OBJECT_NOT_FOUND";
  }
  return "PROBE_FAILED";
}

function requireEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProbeError(`${name}_REQUIRED`);
  }
  return value;
}

function parseLoopbackUrl(value, protocols, errorCode) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      !protocols.includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
      (url.protocol !== "mysql:" && (url.username || url.password))
    ) {
      throw new Error("URL_BOUNDARY_INVALID");
    }
    return url;
  } catch {
    throw new ProbeError(errorCode);
  }
}

async function downloadObject(storage, config, artifact, retainBytes) {
  if (
    typeof artifact.storageKey !== "string" ||
    typeof artifact.byteLength !== "number" ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > maxObjectBytes ||
    typeof artifact.mediaType !== "string" ||
    !/^[A-F0-9]{64}$/u.test(artifact.sha256)
  ) {
    throw new ProbeError("ARTIFACT_METADATA_INVALID");
  }
  const response = await storage.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: artifact.storageKey }),
  );
  if (
    response.ContentLength !== undefined &&
    response.ContentLength > maxObjectBytes
  ) {
    throw new ProbeError("OBJECT_READ_BUDGET_EXCEEDED");
  }
  if (!response.Body) throw new ProbeError("OBJECT_BODY_MISSING");
  const hash = createHash("sha256");
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of response.Body) {
    const bytes = Buffer.from(chunk);
    byteLength += bytes.byteLength;
    if (byteLength > maxObjectBytes) {
      throw new ProbeError("OBJECT_READ_BUDGET_EXCEEDED");
    }
    hash.update(bytes);
    if (retainBytes) chunks.push(bytes);
  }
  const sha256 = hash.digest("hex").toUpperCase();
  if (byteLength !== artifact.byteLength || sha256 !== artifact.sha256) {
    throw new ProbeError("OBJECT_EVIDENCE_MISMATCH");
  }
  return {
    byteLength,
    sha256,
    mediaType: response.ContentType ?? null,
    ...(retainBytes ? { bytes: Buffer.concat(chunks, byteLength) } : {}),
  };
}

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

module.exports = {
  ProbeError,
  createStorageClient,
  inspectArtifactObject,
  inspectPackageInput,
  parseProbeArguments,
  parseProbeEnvironment,
  probeObjectStorageRoundTrip,
  summarizeFactoryConfig,
  toStableErrorCode,
};
