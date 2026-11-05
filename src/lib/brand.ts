// Identidade da marca em um lugar só (nome, chamadas e cores usadas fora do CSS,
// como e-mails, PDF, imagem de compartilhamento e manifesto). Sem "server-only":
// também é lido por componentes de cliente.

export const BRAND = {
  /** Nome oficial: sempre "QQPega", com essa capitalização. */
  name: "QQPega",
  tagline: "Ingressos para o que está rolando na sua cidade",
  description: "Descubra shows, festas, teatro e tudo o que está rolando perto de você. Compre ingressos com PIX ou cartão e receba no celular.",
  /** Assinatura curta para e-mails e rodapés. */
  signature: "Equipe QQPega",
} as const;

/** Cores para lugares sem acesso às variáveis CSS (e-mail, PDF, OG, manifesto). */
export const BRAND_COLORS = {
  night: "#16121f",
  plum: "#2a1740",
  berry: "#8c1450",
  pink: "#d1145a",
  lime: "#c6f432",
  paper: "#fbfaf7",
  muted: "#f2efe9",
  mutedText: "#5b5566",
  border: "#e6e1d8",
} as const;
