// Log estruturado: uma linha por evento, com prefixo legível e JSON depois, para o
// provedor de hospedagem indexar (`[area] {"area":...,"event":...,"level":...}`).
// Campos com nome de segredo são mascarados mesmo se alguém os passar por engano.
import "server-only";

export type LogLevel = "error" | "warn" | "info";

const SENSITIVE_KEY = /secret|token|password|passphrase|authorization|cookie|api[-_]?key|private[-_]?key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]));
}

export function logEvent(level: LogLevel, area: string, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ area, event, level, ...(redact(fields) as Record<string, unknown>), at: new Date().toISOString() });
  console[level](`[${area}] ${line}`);
}
