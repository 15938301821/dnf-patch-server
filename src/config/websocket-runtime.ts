/**
 * @fileoverview Configures deterministic WebSocket runtime behavior before Nest dependencies load.
 * It does not expose caller-controlled transport settings or modify third-party packages.
 * @module config
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A (direct startup debugging request)
 */

process.env.WS_NO_BUFFER_UTIL = "1";
