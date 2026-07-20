interface ErrorWithCode {
  code?: unknown;
  cause?: unknown;
}

export function isMysqlDuplicateEntry(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const candidate = current as ErrorWithCode;
    if (candidate.code === "ER_DUP_ENTRY") return true;
    current = candidate.cause;
  }
  return false;
}
