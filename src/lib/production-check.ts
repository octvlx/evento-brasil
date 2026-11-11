// Verificação de configuração antes do deploy de produção (npm run deploy:check).
// Complementa o que src/server/env.ts já recusa ao iniciar: aqui entram os itens que
// não impedem o app de subir, mas quebram ou enfraquecem a produção (imagens em disco
// local, 2FA desligado, chaves curtas ou repetidas, Mercado Pago incompleto...).
// Nunca devolve valores das variáveis, só os nomes: a saída pode ir para logs de CI.

export type CheckLevel = "ok" | "warn" | "fail";
export interface CheckItem {
  level: CheckLevel;
  title: string;
  detail?: string;
}

type Vars = Record<string, string | undefined>;

const filled = (v: string | undefined) => !!v && v.trim() !== "";
const base64Bytes = (v: string | undefined) => (filled(v) ? Buffer.from(v!, "base64").length : 0);
const isTrue = (v: string | undefined) => v === "true";

function url(v: string | undefined): URL | null {
  try {
    return v ? new URL(v) : null;
  } catch {
    return null;
  }
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$|\.(localhost|test|local)$/i;

/** Variáveis que dependem umas das outras: ou todas preenchidas, ou nenhuma. */
function group(vars: Vars, title: string, names: string[], whenOff: string): CheckItem {
  const set = names.filter((n) => filled(vars[n]));
  if (set.length === 0) return { level: "ok", title, detail: whenOff };
  if (set.length === names.length) return { level: "ok", title, detail: "configurado" };
  return { level: "fail", title, detail: `incompleto; faltam: ${names.filter((n) => !filled(vars[n])).join(", ")}` };
}

export function checkProductionEnv(vars: Vars): CheckItem[] {
  const items: CheckItem[] = [];
  const add = (level: CheckLevel, title: string, detail?: string) => items.push({ level, title, detail });

  // URL pública
  const app = url(vars.APP_BASE_URL || vars.APP_URL);
  if (!app) add("fail", "APP_URL", "ausente ou inválida");
  else if (app.protocol !== "https:") add("fail", "APP_URL", "precisa usar HTTPS");
  else if (LOCAL_HOSTS.test(app.hostname)) add("fail", "APP_URL", "aponta para um endereço local");
  else add("ok", "APP_URL", app.origin);

  // Banco
  const dbUrl = url(vars.DATABASE_URL);
  if (!dbUrl) add("fail", "DATABASE_URL", "ausente ou inválida");
  else if (LOCAL_HOSTS.test(dbUrl.hostname)) add("warn", "DATABASE_URL", "aponta para um banco local; confirme que é o banco de produção");
  else if (!/^(require|verify-ca|verify-full)$/.test(dbUrl.searchParams.get("sslmode") ?? "")) add("warn", "DATABASE_URL", "sem sslmode=require; confirme que a conexão com o banco é criptografada");
  else add("ok", "DATABASE_URL", "conexão com TLS");

  // Segredos: tamanho mínimo, formato e nenhum repetido.
  const secrets: [string, number][] = [
    ["AUTH_SECRET", 32],
    ["CRON_SECRET", 24],
  ];
  for (const [name, min] of secrets) {
    const v = vars[name];
    if (!filled(v)) add("fail", name, "ausente");
    else if (v!.startsWith("dev-only")) add("fail", name, "ainda é o valor de desenvolvimento");
    else if (v!.length < min) add("fail", name, `curto demais (mínimo ${min} caracteres aleatórios)`);
    else add("ok", name);
  }
  const dek = vars.DATA_ENCRYPTION_KEY;
  if (!filled(dek) || dek!.startsWith("dev-only")) add("fail", "DATA_ENCRYPTION_KEY", "ausente ou valor de desenvolvimento");
  else if (base64Bytes(dek) !== 32) add("fail", "DATA_ENCRYPTION_KEY", "precisa ter 32 bytes em base64");
  else add("ok", "DATA_ENCRYPTION_KEY", "guarde uma cópia segura: sem ela, CPF/CNPJ e 2FA cifrados ficam ilegíveis");
  const secretNames = ["AUTH_SECRET", "DATA_ENCRYPTION_KEY", "CRON_SECRET", "MERCADO_PAGO_TOKEN_ENCRYPTION_KEY", "MERCADO_PAGO_WEBHOOK_SECRET", "SIMULATED_WEBHOOK_SECRET"];
  const seen = new Map<string, string>();
  const repeated: string[] = [];
  for (const n of secretNames) {
    const v = vars[n];
    if (!filled(v)) continue;
    const prev = seen.get(v!);
    if (prev) repeated.push(`${prev} = ${n}`);
    else seen.set(v!, n);
  }
  if (repeated.length) add("fail", "Segredos repetidos", `cada segredo precisa ser único: ${repeated.join("; ")}`);

  // Pagamentos
  const provider = vars.PAYMENT_PROVIDER || "simulated";
  if (provider === "simulated") add("fail", "PAYMENT_PROVIDER", "simulated não cobra de verdade; use mercadopago");
  else if (provider === "mercadopago") {
    const missing = ["MERCADO_PAGO_CLIENT_ID", "MERCADO_PAGO_CLIENT_SECRET", "MERCADO_PAGO_WEBHOOK_SECRET", "MERCADO_PAGO_TOKEN_ENCRYPTION_KEY"].filter((n) => !filled(vars[n]));
    if (missing.length) add("fail", "Mercado Pago", `faltam: ${missing.join(", ")}`);
    else if (base64Bytes(vars.MERCADO_PAGO_TOKEN_ENCRYPTION_KEY) !== 32) add("fail", "Mercado Pago", "MERCADO_PAGO_TOKEN_ENCRYPTION_KEY precisa ter 32 bytes em base64");
    else add("ok", "Mercado Pago", "credenciais da aplicação presentes (teste de pagamento real ainda é manual)");
  } else add("fail", "PAYMENT_PROVIDER", "valor desconhecido");
  if (isTrue(vars.ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION)) add("fail", "ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION", "só para homologação; desligue em produção");
  if (isTrue(vars.MERCADO_PAGO_OAUTH_TEST_TOKEN)) add("fail", "MERCADO_PAGO_OAUTH_TEST_TOKEN", "é só para sandbox");
  if (!isTrue(vars.SETTLEMENT_ENABLED)) add("warn", "SETTLEMENT_ENABLED", "repasse automático aos organizadores desligado; repasses serão manuais");

  // E-mail
  if (vars.EMAIL_PROVIDER !== "resend") add("fail", "EMAIL_PROVIDER", "configure resend (console não envia e-mails)");
  else if (!filled(vars.RESEND_API_KEY) && !filled(vars.EMAIL_API_KEY)) add("fail", "EMAIL_PROVIDER", "falta RESEND_API_KEY");
  else add("ok", "EMAIL_PROVIDER", "resend");
  const from = vars.EMAIL_FROM?.match(/<([^>]+)>/)?.[1] ?? vars.EMAIL_FROM ?? "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from) || /@(resend\.dev|example\.(com|org)|localhost)$/i.test(from)) add("fail", "EMAIL_FROM", "precisa ser um remetente do seu domínio verificado no provedor");
  else add("ok", "EMAIL_FROM", `domínio ${from.split("@")[1]} (confirme que está verificado no Resend)`);

  // Imagens: em disco local somem a cada deploy e não são compartilhadas entre instâncias.
  if (vars.STORAGE_PROVIDER !== "s3") add("fail", "STORAGE_PROVIDER", "use s3: imagens em disco local se perdem a cada deploy");
  else {
    const missing = ["OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY", "OBJECT_STORAGE_PUBLIC_URL"].filter((n) => !filled(vars[n]));
    if (missing.length) add("fail", "Armazenamento de imagens", `faltam: ${missing.join(", ")}`);
    else if (url(vars.OBJECT_STORAGE_PUBLIC_URL)?.protocol !== "https:") add("fail", "OBJECT_STORAGE_PUBLIC_URL", "precisa ser uma URL HTTPS");
    else add("ok", "Armazenamento de imagens", "s3");
  }

  // Contas
  if (vars.MFA_REQUIRED === "false") add("fail", "MFA_REQUIRED", "2FA desligado para administradores e donos de organização; deixe vazio ou true");
  else add("ok", "MFA_REQUIRED", "2FA obrigatório para administradores e donos");
  if (vars.PASSWORD_BREACH_CHECK === "false") add("warn", "PASSWORD_BREACH_CHECK", "consulta de senhas vazadas desligada");

  // Integrações opcionais: tudo ou nada.
  items.push(group(vars, "Login com Google", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], "desligado"));
  items.push(group(vars, "Apple Wallet", ["APPLE_WALLET_PASS_TYPE_ID", "APPLE_WALLET_TEAM_ID", "APPLE_WALLET_SIGNER_CERT", "APPLE_WALLET_SIGNER_KEY", "APPLE_WALLET_WWDR_CERT"], "desligado"));
  items.push(group(vars, "Google Wallet", ["GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL", "GOOGLE_WALLET_PRIVATE_KEY"], "desligado"));

  return items;
}

export interface DbFacts {
  pendingMigrations: string[];
  failedMigrations: string[];
  demoAccounts: number;
  activeAdmins: number;
  adminsWithoutMfa: number;
  cities: number;
}

export function checkProductionDb(f: DbFacts): CheckItem[] {
  const items: CheckItem[] = [];
  const add = (level: CheckLevel, title: string, detail?: string) => items.push({ level, title, detail });
  if (f.failedMigrations.length) add("fail", "Migrações com falha", f.failedMigrations.join(", "));
  if (f.pendingMigrations.length) add("warn", "Migrações pendentes", `${f.pendingMigrations.length}; rode npm run db:deploy antes de iniciar a nova versão`);
  else if (!f.failedMigrations.length) add("ok", "Migrações", "todas aplicadas");
  if (f.demoAccounts > 0) add("fail", "Contas de demonstração", `${f.demoAccounts} no banco; o seed de demonstração não pode rodar em produção`);
  else add("ok", "Contas de demonstração", "nenhuma");
  if (f.activeAdmins === 0) add("fail", "Administrador", "nenhum administrador ativo; crie com npm run admin:promote -- <e-mail>");
  else if (f.adminsWithoutMfa > 0) add("warn", "Administrador", `${f.adminsWithoutMfa} de ${f.activeAdmins} sem 2FA ativado (o painel exige ao entrar)`);
  else add("ok", "Administrador", `${f.activeAdmins} ativo(s), todos com 2FA`);
  if (f.cities === 0) add("warn", "Cidades", "tabela vazia; rode npm run cities:import");
  else add("ok", "Cidades", `${f.cities} cadastradas`);
  return items;
}

export const hasFailures = (items: CheckItem[]) => items.some((i) => i.level === "fail");
