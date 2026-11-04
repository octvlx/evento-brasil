import "server-only";

// Quem precisa da verificação em duas etapas: administradores da plataforma e
// donos de organização (mexem em dinheiro, repasses e dados de compradores).
// MFA_REQUIRED liga ou desliga a exigência; sem valor, vale só em produção, para
// o ambiente local e os testes funcionarem com as contas de demonstração.
// Lido direto de process.env (não do env() em cache) para os testes poderem trocar.

export function mfaEnforced(): boolean {
  const v = process.env.MFA_REQUIRED;
  if (v === "true") return true;
  if (v === "false") return false;
  return process.env.NODE_ENV === "production";
}

export const MFA_SETUP_PATH = "/minha-conta/seguranca";
export const MFA_REQUIRED_MESSAGE =
  "Ative a verificação em duas etapas em Minha conta › Segurança para acessar esta área.";

/** O ator precisa ativar o 2FA antes de usar uma área privilegiada. */
export function needsMfaEnrollment(actor: { totpEnabledAt?: Date | null }): boolean {
  return mfaEnforced() && !actor.totpEnabledAt;
}
