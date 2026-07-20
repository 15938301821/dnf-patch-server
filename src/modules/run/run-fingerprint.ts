import { sha256JcsV1 } from "../../common/utils/canonical.js";
import type { CreateRunInput } from "./run.contracts.js";

/** 服务器幂等指纹覆盖完整、已解析的请求，不替代客户端提供的证据哈希。 */
export function createRunRequestFingerprint(input: CreateRunInput): string {
  return sha256JcsV1({
    schemaVersion: 1,
    ...input,
    requestSha256: input.requestSha256.toUpperCase(),
    policySha256: input.policySha256.toUpperCase(),
  });
}
