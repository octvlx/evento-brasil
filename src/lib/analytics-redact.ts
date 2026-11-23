// Endereços enviados ao Vercel Web Analytics e ao Speed Insights (beforeSend).
// Alguns caminhos SÃO credenciais (convite, transferência, posse da organização) ou
// identificam uma pessoa/pedido; a query pode ter token (?token=) ou dado pessoal
// (busca do admin por e-mail). Tudo isso sai antes de deixar o navegador.

// "*" = qualquer segmento mantido; "[nome]" = segmento trocado pelo marcador.
const SENSITIVE_ROUTES: readonly (readonly string[])[] = [
  ["convite", "[token]"],
  ["transferencia", "[token]"],
  ["organizador", "propriedade", "[token]"],
  ["ingressos", "[code]"],
  ["pedido", "[orderId]"],
  ["checkout", "revisao", "[draftId]"],
  ["checkout", "[orderId]"],
  ["check-in", "[eventId]"],
  ["organizador", "eventos", "[id]"],
  ["admin", "*", "[id]"],
];

// Parâmetros de campanha: não identificam ninguém e alimentam as origens de tráfego.
const KEPT_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

function redactPath(pathname: string): string {
  const segments = pathname.split("/");
  const parts = segments.slice(1); // pathname começa com "/"
  for (const pattern of SENSITIVE_ROUTES) {
    if (parts.length < pattern.length) continue;
    const matches = pattern.every((p, i) => p.startsWith("[") || p === "*" || p === parts[i]);
    // "novo" e afins são páginas fixas, não identificadores.
    if (!matches || (pattern.at(-1)!.startsWith("[") && parts[pattern.length - 1] === "novo")) continue;
    pattern.forEach((p, i) => {
      if (p.startsWith("[")) parts[i] = p;
    });
    break;
  }
  return "/" + parts.join("/");
}

/** URL segura para métricas: caminho sem identificadores, só parâmetros utm_*, sem #. */
export function redactAnalyticsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, "https://placeholder.invalid");
  } catch {
    return "/";
  }
  const kept = new URLSearchParams();
  for (const key of KEPT_PARAMS) {
    const value = parsed.searchParams.get(key);
    if (value !== null) kept.set(key, value);
  }
  const query = kept.toString();
  const path = redactPath(parsed.pathname) + (query ? `?${query}` : "");
  return /^https?:\/\//i.test(url) ? `${parsed.origin}${path}` : path;
}

export function redactAnalyticsEvent<T extends { url: string }>(event: T): T {
  return { ...event, url: redactAnalyticsUrl(event.url) };
}
