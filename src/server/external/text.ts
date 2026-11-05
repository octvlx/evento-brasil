// Texto de fontes externas → texto puro e seguro. Nunca devolvemos HTML de terceiros:
// tags são removidas, entidades decodificadas, controles e espaços normalizados e o
// tamanho limitado. A renderização no React escapa o resto.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  aacute: "á",
  agrave: "à",
  acirc: "â",
  atilde: "ã",
  eacute: "é",
  ecirc: "ê",
  iacute: "í",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  uacute: "ú",
  ccedil: "ç",
  Aacute: "Á",
  Agrave: "À",
  Acirc: "Â",
  Atilde: "Ã",
  Eacute: "É",
  Ecirc: "Ê",
  Iacute: "Í",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Uacute: "Ú",
  Ccedil: "Ç",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED[code] ?? m;
  });
}

/** Remove scripts/estilos/comentários e todas as tags, mantendo quebras entre blocos. */
export function htmlToLines(html: string): string[] {
  const noBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|iframe|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, "\n");
  return decodeEntities(noBlocks)
    .split("\n")
    .map((l) => cleanText(l))
    .filter(Boolean);
}

/** Texto de uma linha: sem tags remanescentes, sem caracteres de controle, espaços normalizados. */
export function cleanText(s: string, max = 300): string {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Valor de uma meta tag (property ou name), já limpo. */
export function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  const content = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? cleanText(content) : null;
}
