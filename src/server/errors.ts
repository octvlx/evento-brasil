// Erros de domínio com mensagens seguras para o usuário (pt-BR).

export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "SOLD_OUT"
  | "SALES_CLOSED"
  | "LIMIT_EXCEEDED"
  | "INVALID_STATE"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  // Há versão vigente dos termos ainda não aceita (R10).
  | "TERMS_REQUIRED"
  // Área privilegiada (admin, dono de organização) sem verificação em duas etapas ativa.
  | "MFA_REQUIRED";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const forbidden = (msg = "Você não tem permissão para esta ação.") => new AppError("FORBIDDEN", msg);
export const notFound = (msg = "Recurso não encontrado.") => new AppError("NOT_FOUND", msg);
export const invalidState = (msg: string) => new AppError("INVALID_STATE", msg);

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code?: AppErrorCode };

/** Converte exceções em resultado serializável para Server Actions. */
export async function toActionResult<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, code: err.code };
    // Erros de redirect/notFound do Next precisam ser propagados.
    if (err && typeof err === "object" && "digest" in err) throw err;
    console.error(err);
    return { ok: false, error: "Ocorreu um erro inesperado. Tente novamente." };
  }
}
