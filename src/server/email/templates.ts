import { escapeHtml } from "./index";
import { BRAND, BRAND_COLORS as C } from "@/lib/brand";
export function emailLayout(
  title: string,
  body: string,
  button?: { label: string; url: string },
) {
  const safe = escapeHtml;
  return (
    // Cabeçalho escuro com o logotipo tipográfico ("QQ" em limão), botão limão com texto escuro
    // (contraste 14:1) e fundo papel. Estilos inline: clientes de e-mail ignoram <style>.
    `<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:${C.paper};font-family:Arial,Helvetica,sans-serif;color:${C.night}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="width:100%;max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid ${C.border}" cellspacing="0" cellpadding="0"><tr><td style="padding:22px 28px;background:${C.night};color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-1px"><span style="color:${C.lime}">QQ</span>Pega</td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:${C.night}">` +
    safe(title) +
    "</h1>" +
    body +
    (button
      ? `<p style="margin:28px 0"><a style="display:inline-block;background:${C.lime};color:${C.night};text-decoration:none;padding:14px 24px;border-radius:999px;font-weight:bold" href="` +
        safe(button.url) +
        '">' +
        safe(button.label) +
        `</a></p><p style="font-size:12px;color:${C.mutedText};word-break:break-all">Se o botão não abrir, copie o endereço: ` +
        safe(button.url) +
        "</p>"
      : "") +
    `</td></tr><tr><td style="padding:20px 28px;border-top:1px solid ${C.border};background:${C.muted};font-size:12px;color:${C.mutedText}">Mensagem automática da ${BRAND.name}. Proteja sua conta e não compartilhe links de acesso ou ingressos.</td></tr></table></td></tr></table></body></html>`
  );
}
export function authEmail(
  kind: "reset" | "verify",
  url: string,
  minutes: number,
) {
  const reset = kind === "reset";
  const title = reset ? "Redefinição de senha" : `Boas-vindas à ${BRAND.name}!`;
  const subject = reset
    ? `Redefinição de senha | ${BRAND.name}`
    : `Confirme seu e-mail | ${BRAND.name}`;
  const intro = reset
    ? "Recebemos um pedido de redefinição da sua senha."
    : "Que bom ter você por aqui! Confirme seu endereço de e-mail para concluir compras e usar operações que exigem verificação.";
  const label = reset ? "Redefinir senha" : "Confirmar meu e-mail";
  return {
    subject,
    html: emailLayout(
      title,
      "<p>" +
        intro +
        "</p><p>O link expira em " +
        minutes +
        " minutos e só pode ser utilizado uma vez.</p><p>Se você não solicitou esta mensagem, ignore-a.</p>",
      { label, url },
    ),
    text:
      title +
      "\n" +
      intro +
      "\n" +
      label +
      ": " +
      url +
      "\nValidade: " +
      minutes +
      " minutos. Se você não solicitou, ignore esta mensagem.",
  };
}
export function transactionalEmail(
  kind:
    | "purchase"
    | "tickets"
    | "cancelled"
    | "refund"
    | "cancellation"
    | "invitation"
    | "event",
  title: string,
  lines: string[],
  url: string,
) {
  const subjects = {
    purchase: `Compra confirmada | ${BRAND.name}`,
    tickets: `Seus ingressos chegaram | ${BRAND.name}`,
    cancelled: `Atualização importante sobre seu evento | ${BRAND.name}`,
    refund: `Atualização do seu reembolso | ${BRAND.name}`,
    cancellation: `Seu pedido de cancelamento | ${BRAND.name}`,
    invitation: `Você recebeu um convite | ${BRAND.name}`,
    event: `Atualização importante sobre seu evento | ${BRAND.name}`,
  };
  const label =
    kind === "invitation"
      ? "Visualizar convite"
      : kind === "tickets"
        ? "Visualizar meus ingressos"
        : "Ver detalhes";
  return {
    subject: subjects[kind],
    html: emailLayout(
      title,
      lines.map((line) => "<p>" + escapeHtml(line) + "</p>").join(""),
      { label, url },
    ),
    text: [title, ...lines, label + ": " + url].join("\n"),
  };
}
/** Aviso de segurança após troca ou redefinição de senha. Nunca leva senha, hash ou token. */
/** Aviso de que um administrador redefiniu a verificação em duas etapas da conta. */
export function twoFactorResetEmail(securityUrl: string) {
  const lines = [
    "Olá!",
    `A verificação em duas etapas da sua conta ${BRAND.name} foi redefinida pela nossa equipe, a seu pedido.`,
    "Todas as sessões foram encerradas. No próximo acesso, entre com sua senha e ative de novo a verificação em duas etapas com o aplicativo autenticador.",
    "Se você não pediu essa redefinição, troque sua senha e fale imediatamente com o suporte.",
    `${BRAND.signature}.`,
  ];
  return {
    subject: `${BRAND.name} — Sua verificação em duas etapas foi redefinida`,
    html: emailLayout(
      "Verificação em duas etapas redefinida",
      lines.map((line) => "<p>" + escapeHtml(line) + "</p>").join(""),
      { label: "Ativar de novo", url: securityUrl },
    ),
    text: [...lines, "Ativar de novo: " + securityUrl].join("\n"),
  };
}

export function passwordChangedEmail(kind: "changed" | "reset", resetUrl: string) {
  const what = kind === "changed" ? "alterada" : "redefinida";
  const lines = [
    "Olá!",
    `A senha da sua conta ${BRAND.name} foi ${what} com sucesso.`,
    "Se você realizou essa alteração, nenhuma ação adicional é necessária.",
    "Se você não reconhece essa atividade, solicite imediatamente uma redefinição de senha e entre em contato com o suporte.",
    `${BRAND.signature}.`,
  ];
  return {
    subject: `${BRAND.name} — Sua senha foi ${what}`,
    html: emailLayout(
      `Sua senha foi ${what}`,
      lines.map((line) => "<p>" + escapeHtml(line) + "</p>").join(""),
      { label: "Não fui eu: redefinir senha", url: resetUrl },
    ),
    text: [...lines, "Não fui eu: " + resetUrl].join("\n"),
  };
}
