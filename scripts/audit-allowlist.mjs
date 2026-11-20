// Auditoria de TODAS as dependências (alta ou pior) com exceções explícitas e com prazo.
// Substitui `npm audit --audit-level=high` na CI. Falha com qualquer alerta alto ou
// crítico, exceto os listados abaixo. Cada exceção tem um prazo: vencido, a CI volta a
// falhar e a exceção precisa ser revista. A auditoria das dependências de produção
// (`npm audit --omit=dev --audit-level=moderate`) continua sem exceções.
// Só usa o Node e o npm: não precisa de `npm install`.
import { spawnSync } from "node:child_process";

/**
 * Exceções: { id: "GHSA-…", package, reason, until: "AAAA-MM-DD" }. Só para alerta sem
 * versão corrigida e fora do app em produção; remova a entrada assim que houver correção
 * (e atualize o lockfile). Vazia hoje: a do picomatch (GHSA-fc5q-39xc-vjpf) saiu quando o
 * alerta foi retirado pelo GitHub em 2026-11-18.
 * @type {{ id: string; package: string; reason: string; until: string }[]}
 */
const ALLOWLIST = [];

const BLOCKING = new Set(["high", "critical"]);
const today = new Date().toISOString().slice(0, 10);

// No Windows o npm é um .cmd e precisa do shell (comando fixo, sem argumentos externos).
const win = process.platform === "win32";
const res = spawnSync(win ? "npm audit --json" : "npm", win ? [] : ["audit", "--json"], { encoding: "utf8", shell: win, maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error("Não foi possível ler a saída de `npm audit --json`:\n", res.stderr || res.stdout);
  process.exit(2);
}
if (report.error) {
  console.error("`npm audit` falhou:", report.error.summary ?? report.error);
  process.exit(2);
}

// Alertas de verdade ficam nos objetos de `via`; strings só apontam para outro pacote.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== "object") continue;
    const id = String(via.url ?? "").split("/").pop() || String(via.source);
    if (!advisories.has(id)) advisories.set(id, { id, package: via.name, severity: via.severity, title: via.title, range: via.range, url: via.url });
  }
}

const blocking = [...advisories.values()].filter((a) => BLOCKING.has(a.severity));
const failures = [];
const allowed = [];
for (const a of blocking) {
  const entry = ALLOWLIST.find((e) => e.id === a.id && e.package === a.package);
  if (!entry) failures.push(`${a.severity.toUpperCase()} ${a.package} ${a.range}: ${a.title} (${a.url})`);
  else if (entry.until < today) failures.push(`Exceção vencida em ${entry.until}: ${a.id} (${a.package}). Reveja: ainda sem correção? Atualize o prazo; com correção, atualize o lockfile e remova a exceção.`);
  else allowed.push(`${a.id} (${a.package}) até ${entry.until}: ${entry.reason}`);
}
const stale = ALLOWLIST.filter((e) => !blocking.some((a) => a.id === e.id && a.package === e.package));

for (const line of allowed) console.log(`Permitido: ${line}`);
for (const e of stale) console.log(`Exceção sem uso: ${e.id} (${e.package}) não aparece mais. Remova-a de scripts/audit-allowlist.mjs.`);
const others = [...advisories.values()].filter((a) => !BLOCKING.has(a.severity));
if (others.length) console.log(`Abaixo do limite (não bloqueiam): ${others.map((a) => `${a.severity} ${a.package} ${a.id}`).join("; ")}`);

if (failures.length) {
  console.error(`\nAuditoria reprovada (${failures.length}):`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(`\nAuditoria aprovada: nenhum alerta alto ou crítico fora das exceções (${blocking.length} permitido(s)).`);
