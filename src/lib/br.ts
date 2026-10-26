// Utilidades brasileiras: UFs, CPF/CNPJ, telefone, CEP.

export const UFS = [
  { uf: "AC", name: "Acre", timezone: "America/Rio_Branco" },
  { uf: "AL", name: "Alagoas", timezone: "America/Maceio" },
  { uf: "AP", name: "Amapá", timezone: "America/Belem" },
  { uf: "AM", name: "Amazonas", timezone: "America/Manaus" },
  { uf: "BA", name: "Bahia", timezone: "America/Bahia" },
  { uf: "CE", name: "Ceará", timezone: "America/Fortaleza" },
  { uf: "DF", name: "Distrito Federal", timezone: "America/Sao_Paulo" },
  { uf: "ES", name: "Espírito Santo", timezone: "America/Sao_Paulo" },
  { uf: "GO", name: "Goiás", timezone: "America/Sao_Paulo" },
  { uf: "MA", name: "Maranhão", timezone: "America/Fortaleza" },
  { uf: "MT", name: "Mato Grosso", timezone: "America/Cuiaba" },
  { uf: "MS", name: "Mato Grosso do Sul", timezone: "America/Campo_Grande" },
  { uf: "MG", name: "Minas Gerais", timezone: "America/Sao_Paulo" },
  { uf: "PA", name: "Pará", timezone: "America/Belem" },
  { uf: "PB", name: "Paraíba", timezone: "America/Fortaleza" },
  { uf: "PR", name: "Paraná", timezone: "America/Sao_Paulo" },
  { uf: "PE", name: "Pernambuco", timezone: "America/Recife" },
  { uf: "PI", name: "Piauí", timezone: "America/Fortaleza" },
  { uf: "RJ", name: "Rio de Janeiro", timezone: "America/Sao_Paulo" },
  { uf: "RN", name: "Rio Grande do Norte", timezone: "America/Fortaleza" },
  { uf: "RS", name: "Rio Grande do Sul", timezone: "America/Sao_Paulo" },
  { uf: "RO", name: "Rondônia", timezone: "America/Porto_Velho" },
  { uf: "RR", name: "Roraima", timezone: "America/Boa_Vista" },
  { uf: "SC", name: "Santa Catarina", timezone: "America/Sao_Paulo" },
  { uf: "SP", name: "São Paulo", timezone: "America/Sao_Paulo" },
  { uf: "SE", name: "Sergipe", timezone: "America/Maceio" },
  { uf: "TO", name: "Tocantins", timezone: "America/Araguaina" },
] as const;

export type UF = (typeof UFS)[number]["uf"];
export const UF_CODES = UFS.map((u) => u.uf) as [UF, ...UF[]];

/** Fusos usados no Brasil (inclui Fernando de Noronha e oeste do Amazonas). */
export const BR_TIMEZONES = [
  "America/Noronha",
  "America/Sao_Paulo",
  "America/Bahia",
  "America/Fortaleza",
  "America/Recife",
  "America/Maceio",
  "America/Belem",
  "America/Araguaina",
  "America/Santarem",
  "America/Campo_Grande",
  "America/Cuiaba",
  "America/Manaus",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/Rio_Branco",
  "America/Eirunepe",
] as const;

export function isUF(value: string): value is UF {
  return (UF_CODES as readonly string[]).includes(value);
}

export function defaultTimezoneForUF(uf: string): string {
  return UFS.find((u) => u.uf === uf)?.timezone ?? "America/Sao_Paulo";
}

export const onlyDigits = (s: string) => s.replace(/\D/g, "");

export function isValidCPF(input: string): boolean {
  const cpf = onlyDigits(input);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

export function isValidCNPJ(input: string): boolean {
  const cnpj = onlyDigits(input);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(cnpj[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(cnpj[12]) && calc(13) === Number(cnpj[13]);
}

export function formatCPF(input: string): string {
  return onlyDigits(input).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

export function formatCNPJ(input: string): string {
  return onlyDigits(input).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

/** Celular brasileiro: DDD válido (11–99, sem zero) + 9 + 8 dígitos. Aceita +55. */
export function isValidMobileBR(input: string): boolean {
  let d = onlyDigits(input);
  if (d.length === 13 && d.startsWith("55")) d = d.slice(2);
  return /^[1-9][1-9]9\d{8}$/.test(d);
}

export function formatPhoneBR(input: string): string {
  let d = onlyDigits(input);
  if (d.length === 13 && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, "($1) $2-$3");
  if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, "($1) $2-$3");
  return input;
}

export function formatCEP(input: string): string {
  return onlyDigits(input).replace(/^(\d{5})(\d{3})$/, "$1-$2");
}

export function formatAddress(parts: {
  addressLine?: string | null;
  district?: string | null;
  city: string;
  state: string;
  postalCode?: string | null;
}): string {
  const head = [parts.addressLine, parts.district].filter(Boolean).join(" – ");
  const tail = `${parts.city} – ${parts.state}`;
  const cep = parts.postalCode ? `, CEP ${formatCEP(parts.postalCode)}` : "";
  return head ? `${head}, ${tail}${cep}` : `${tail}${cep}`;
}
