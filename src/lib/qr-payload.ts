// Formato do QR do ingresso, usado no servidor (check-in online) e no aparelho da
// portaria (check-in offline). Sem segredos: o token é aleatório e não derivável.

export const QR_PREFIX = "EB1";

export function qrPayload(ticket: { code: string; validationToken: string }): string {
  return `${QR_PREFIX}:${ticket.code}:${ticket.validationToken}`;
}

export function parseQrPayload(raw: string): { code: string; token: string } | null {
  const m = /^EB1:([0-9A-HJKMNP-TV-Z]{10}):([A-Za-z0-9_-]{43})$/.exec(raw.trim());
  return m ? { code: m[1], token: m[2] } : null;
}
