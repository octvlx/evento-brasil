import "server-only";
import { createHash } from "node:crypto";
import { PASSWORD_MESSAGES, passwordIssues } from "@/lib/password-policy";
import { env } from "../env";
import { AppError } from "../errors";

// Pwned Passwords (Have I Been Pwned) por k-anonimato: só os 5 primeiros caracteres do
// SHA-1 saem do servidor; a comparação do resto é local. "Add-Padding" esconde o
// tamanho da resposta. A senha e o hash completo nunca são enviados nem registrados.
//
// Falha aberta: se o serviço não responder em PWNED_TIMEOUT_MS (ou estiver desligado
// por PASSWORD_BREACH_CHECK=false), a senha segue só com a política local. Uma API
// externa fora do ar não pode impedir cadastro nem troca de senha.
const PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/";
const PWNED_TIMEOUT_MS = 2500;

/** true = senha conhecida em vazamentos; false = não encontrada; null = não foi possível consultar. */
export async function isBreachedPassword(password: string): Promise<boolean | null> {
  if (!env().PASSWORD_BREACH_CHECK) return null;
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(PWNED_RANGE_URL + prefix, {
      headers: { "Add-Padding": "true", "User-Agent": "evento-brasil-password-check" },
      signal: AbortSignal.timeout(PWNED_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.text();
    for (const line of body.split("\n")) {
      const [candidate, count] = line.trim().split(":");
      // Linhas de preenchimento vêm com contagem 0.
      if (candidate === suffix) return Number(count) > 0;
    }
    return false;
  } catch (error) {
    // Sem dados da senha no log: só o motivo.
    console.warn(`[senha] consulta de senhas vazadas indisponível (${error instanceof Error ? error.name : "erro"}); seguindo só com a política local.`);
    return null;
  }
}

/** Política local + senhas vazadas. Lança AppError("VALIDATION") com a primeira mensagem. */
export async function assertAcceptableNewPassword(password: string) {
  const [issue] = passwordIssues(password);
  if (issue) throw new AppError("VALIDATION", issue);
  if (await isBreachedPassword(password)) throw new AppError("VALIDATION", PASSWORD_MESSAGES.breached);
}
