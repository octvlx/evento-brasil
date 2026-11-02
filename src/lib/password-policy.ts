// Política de senhas: uma única fonte para cadastro, redefinição e troca em Minha conta.
// Roda no navegador (lista de requisitos e força enquanto digita) e no servidor, que
// revalida tudo; a checagem de senhas vazadas (Pwned Passwords) é só no servidor
// (src/server/auth/breached-password.ts). Nada aqui envia a senha para fora.
import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordRequirement {
  id: "length" | "upper" | "lower" | "digit" | "special";
  label: string;
  message: string;
  test: (password: string) => boolean;
}

export const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  { id: "length", label: `Mínimo de ${PASSWORD_MIN_LENGTH} caracteres`, message: `Utilize pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`, test: (p) => p.length >= PASSWORD_MIN_LENGTH },
  { id: "upper", label: "Uma letra maiúscula", message: "Adicione uma letra maiúscula.", test: (p) => /\p{Lu}/u.test(p) },
  { id: "lower", label: "Uma letra minúscula", message: "Adicione uma letra minúscula.", test: (p) => /\p{Ll}/u.test(p) },
  { id: "digit", label: "Um número", message: "Adicione pelo menos um número.", test: (p) => /\p{Nd}/u.test(p) },
  { id: "special", label: "Um caractere especial", message: "Adicione pelo menos um caractere especial.", test: (p) => /[^\p{L}\p{Nd}\s]/u.test(p) },
];

export const PASSWORD_MESSAGES = {
  tooLong: `Utilize no máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
  blank: "A senha não pode ser composta apenas por espaços.",
  common: "Esta senha é muito comum. Escolha uma senha mais segura.",
  breached: "Esta senha apareceu em vazamentos de dados conhecidos. Escolha outra senha.",
  mismatch: "As senhas não coincidem.",
  newMismatch: "As novas senhas não coincidem.",
  sameAsCurrent: "A nova senha deve ser diferente da senha atual.",
  sameAsPrevious: "Por segurança, sua nova senha deve ser diferente da anterior.",
} as const;

// Senhas e palavras-base mais usadas no Brasil e no mundo (listas públicas de
// vazamentos). A comparação ignora maiúsculas e números/símbolos nas pontas, então
// "Senha@123" e "Brasil2026!" também caem aqui.
const COMMON_BASES = new Set([
  "senha", "password", "passw0rd", "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbnm", "abc", "abcdef",
  "iloveyou", "teamo", "admin", "administrador", "root", "welcome", "bemvindo", "letmein", "monkey", "dragon",
  "master", "login", "princess", "princesa", "sunshine", "football", "futebol", "flamengo", "corinthians", "palmeiras",
  "saopaulo", "santos", "vasco", "gremio", "cruzeiro", "botafogo", "fluminense", "internacional", "brasil", "brazil",
  "mudar", "mudarsenha", "trocar", "teste", "test", "usuario", "user", "evento", "eventobrasil", "ingresso",
  "ingressos", "deus", "jesus", "jesuscristo", "amor", "familia", "felicidade", "minhasenha", "mypassword", "changeme",
  "secret", "segredo", "default", "padrao", "q1w2e3r4", "1q2w3e4r", "1qaz2wsx", "zaq12wsx", "abc123", "aa",
]);

function commonBase(password: string) {
  return password
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^[^a-z]+|[^a-z]+$/g, "")
    .replace(/[@4]/g, "a")
    .replace(/0/g, "o")
    .replace(/[1!]/g, "i")
    .replace(/3/g, "e")
    .replace(/\$/g, "s");
}

/** Senha óbvia: só sequência/repetição, ou palavra comum com números/símbolos em volta. */
export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(lower)) return true;
  if (/^(0123456789|1234567890|9876543210|abcdefghij|qwertyuiop)/.test(lower.replace(/[^a-z0-9]/g, "")) && lower.replace(/[^a-z0-9]/g, "").length <= 12) return true;
  const base = commonBase(password);
  return base.length === 0 || COMMON_BASES.has(base);
}

/** Mensagens de tudo o que falta, na ordem da lista exibida. Vazio = senha aceita (antes da checagem de vazamentos). */
export function passwordIssues(password: string): string[] {
  if (password.length > PASSWORD_MAX_LENGTH) return [PASSWORD_MESSAGES.tooLong];
  if (password.length > 0 && password.trim().length === 0) return [PASSWORD_MESSAGES.blank];
  const issues = PASSWORD_REQUIREMENTS.filter((r) => !r.test(password)).map((r) => r.message);
  if (!issues.length && isCommonPassword(password)) issues.push(PASSWORD_MESSAGES.common);
  return issues;
}

export type PasswordStrength = { level: 0 | 1 | 2 | 3; label: "" | "Fraca" | "Média" | "Forte" };

/**
 * Estimativa local de força, só para orientar quem digita. Não basta ter os quatro
 * tipos de caractere: comprimento e variedade pesam, e repetições, sequências e
 * palavras comuns derrubam a nota.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (!password) return { level: 0, label: "" };
  if (passwordIssues(password).length) return { level: 1, label: "Fraca" };
  const classes = PASSWORD_REQUIREMENTS.slice(1).filter((r) => r.test(password)).length;
  const unique = new Set(password).size;
  let score = password.length + (classes - 3) * 2 + Math.min(unique, 12) / 2;
  if (/(.)\1\1/.test(password)) score -= 4;
  if (/(012|123|234|345|456|567|678|789|abc|bcd|cde|qwe|asd|zxc)/i.test(password)) score -= 3;
  if (/(19|20)\d\d/.test(password)) score -= 2;
  return score >= 18 ? { level: 3, label: "Forte" } : { level: 2, label: "Média" };
}

/** Senha nova (cadastro, redefinição, troca). O servidor também checa vazamentos. */
export const newPasswordSchema = z.string().superRefine((password, ctx) => {
  const [first] = passwordIssues(password);
  if (first) ctx.addIssue({ code: "custom", message: first });
});
