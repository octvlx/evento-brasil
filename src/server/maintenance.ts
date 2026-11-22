// Modo de manutenção (src/proxy.ts; docs/manutencao.md). Módulo puro, sem banco nem
// "server-only": o proxy roda antes das rotas e não deve depender do resto do app.

/** Sempre liberados: dinheiro em trânsito, tarefas agendadas e o acesso da equipe. */
const ALWAYS_OPEN = [
  "/api/webhooks/", // confirmações e estornos do Mercado Pago não podem se perder
  "/api/cron/", // reservas vencidas, fila de e-mails, alertas, monitor de saúde
  "/api/mercadopago/", // retorno do OAuth de quem estava conectando a conta
  "/admin", // painel, para conferir o site durante a manutenção
  "/entrar", // login e verificação em duas etapas da equipe
  "/auth/", // login com o Google
  "/minha-conta/seguranca", // ativação do 2FA, exigida de admins e da portaria
];

/** Portaria: liberada por padrão, para não parar a entrada de um evento em andamento. */
const CHECKIN = ["/check-in"];

export type MaintenanceConfig = { enabled: boolean; allowCheckin: boolean };

export function maintenanceConfig(env: Record<string, string | undefined> = process.env): MaintenanceConfig {
  return {
    enabled: env.MAINTENANCE_MODE === "true",
    allowCheckin: env.MAINTENANCE_ALLOW_CHECKIN !== "false",
  };
}

const matches = (pathname: string, prefix: string) =>
  prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`);

/** "open": segue normalmente; "page": tela de manutenção; "api": JSON 503. */
export function maintenanceDecision(pathname: string, config: MaintenanceConfig): "open" | "page" | "api" {
  if (!config.enabled) return "open";
  if (ALWAYS_OPEN.some((p) => matches(pathname, p))) return "open";
  if (config.allowCheckin && CHECKIN.some((p) => matches(pathname, p))) return "open";
  return pathname === "/api" || pathname.startsWith("/api/") ? "api" : "page";
}

export const MAINTENANCE_RETRY_AFTER_SECONDS = 1800;

export const MAINTENANCE_MESSAGE = "O TICKET24 está em manutenção. Voltamos em breve.";

export const maintenanceHtml = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Em manutenção · TICKET24</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f7f7f8; color: #18181b; }
  main { max-width: 440px; text-align: center; }
  .brand { font-weight: 800; letter-spacing: .04em; font-size: 20px; }
  h1 { font-size: 26px; margin: 28px 0 12px; }
  p { line-height: 1.55; color: #52525b; margin: 0 0 10px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0b0d; color: #f4f4f5; }
    p { color: #a1a1aa; }
  }
</style>
</head>
<body>
<main>
  <div class="brand">TICKET24</div>
  <h1>Estamos em manutenção</h1>
  <p>Estamos fazendo melhorias no site e voltamos em breve.</p>
  <p>Seus ingressos e pedidos continuam garantidos. Tente de novo em alguns minutos.</p>
</main>
</body>
</html>
`;
