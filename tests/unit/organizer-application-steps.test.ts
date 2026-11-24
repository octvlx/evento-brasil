import { describe, expect, it } from "vitest";
import { organizerApplicationSchema } from "@/features/schemas";
import {
  blankApplication,
  documentStatus,
  firstIncompleteStep,
  isReachable,
  maskDocument,
  maskPhone,
  maskedDocumentTail,
  nextStepAfter,
  normalizeWebsite,
  parseDraft,
  stepForRejection,
  stepForReviewArea,
  toApplicationInput,
  toDraft,
  validStepsOf,
  validateApplicationStep,
  DRAFT_TTL_MS,
} from "@/features/organizer/application-steps";

const complete = blankApplication({
  legalType: "COMPANY",
  name: "Produtora Teste",
  legalName: "Produtora Teste LTDA",
  document: "11.222.333/0001-81",
  contactEmail: "contato@produtora.test",
});

describe("cadastro de organizador em passos", () => {
  it("valida cada passo com as mesmas mensagens do schema do servidor", () => {
    const v = blankApplication({ legalType: "INDIVIDUAL" });
    expect(validateApplicationStep(1, v)).toEqual({});
    expect(validateApplicationStep(2, v)).toEqual({ name: "Informe o nome público" });
    expect(validateApplicationStep(3, v)).toEqual({ legalName: "Informe o nome/razão social", document: "Informe o CPF" });
    expect(validateApplicationStep(3, { ...v, legalName: "Fulana", document: "111.111.111-11" })).toEqual({ document: "CPF inválido" });
    expect(validateApplicationStep(4, { ...v, contactEmail: "x", contactPhone: "(11) 1234" })).toEqual({
      contactEmail: "E-mail inválido",
      contactPhone: "Celular inválido. Use DDD + número, ex.: (11) 91234-5678",
    });
    expect(validateApplicationStep(2, { ...v, name: "Nome", cityUf: "SP" })).toEqual({ cityIbgeCode: "Selecione a cidade na lista" });
  });

  it("passos válidos equivalem a um envio aceito pelo schema completo", () => {
    expect(validStepsOf(complete)).toEqual([1, 2, 3, 4]);
    expect(organizerApplicationSchema.safeParse(toApplicationInput(complete)).success).toBe(true);
    // Trocar o tipo invalida o documento (CNPJ não serve como CPF).
    const asCpf = { ...complete, legalType: "INDIVIDUAL" as const };
    expect(validStepsOf(asCpf)).toEqual([1, 2, 4]);
    expect(organizerApplicationSchema.safeParse(toApplicationInput(asCpf)).success).toBe(false);
  });

  it("só deixa ir aos passos concluídos e ao primeiro pendente", () => {
    expect(firstIncompleteStep([])).toBe(1);
    expect(isReachable(3, [1])).toBe(false);
    expect(isReachable(2, [1])).toBe(true);
    expect(isReachable(5, [1, 2, 4])).toBe(false);
    expect(isReachable(5, [1, 2, 3, 4])).toBe(true);
    expect(nextStepAfter(2, [1, 2], false)).toBe(3);
    // Reenvio que abriu no Contato com os dados legais pendentes: segue para eles.
    expect(nextStepAfter(4, [1, 2, 4], false)).toBe(3);
    // Editando a partir da revisão: volta direto para ela.
    expect(nextStepAfter(2, [1, 2, 3, 4], true)).toBe(5);
  });

  it("mascara documento e celular enquanto a pessoa digita", () => {
    expect(maskDocument("112", "COMPANY")).toBe("11.2");
    expect(maskDocument("11222333000181999", "COMPANY")).toBe("11.222.333/0001-81");
    expect(maskDocument("1234567", "INDIVIDUAL")).toBe("123.456.7");
    expect(maskDocument("52998224725", "INDIVIDUAL")).toBe("529.982.247-25");
    expect(maskPhone("11")).toBe("(11");
    expect(maskPhone("119123")).toBe("(11) 9123");
    expect(maskPhone("11912345678")).toBe("(11) 91234-5678");
    expect(maskPhone("+55 11 91234-5678")).toBe("(11) 91234-5678");
  });

  it("confere o dígito verificador só com o documento completo", () => {
    expect(documentStatus("", "COMPANY")).toBe("empty");
    expect(documentStatus("11.222.333/0001", "COMPANY")).toBe("incomplete");
    expect(documentStatus("11.222.333/0001-81", "COMPANY")).toBe("valid");
    expect(documentStatus("11.111.111/1111-11", "COMPANY")).toBe("invalid");
    expect(documentStatus("529.982.247-25", "INDIVIDUAL")).toBe("valid");
    expect(maskedDocumentTail("11.222.333/0001-81", "COMPANY")).toBe("CNPJ ••• 0181");
  });

  it("completa https:// no site e respeita outro protocolo digitado", () => {
    expect(normalizeWebsite(" produtora.com.br ")).toBe("https://produtora.com.br");
    expect(normalizeWebsite("https://a.com")).toBe("https://a.com");
    expect(normalizeWebsite("http://a.com")).toBe("http://a.com");
    expect(normalizeWebsite("")).toBe("");
  });

  it("abre o reenvio no passo mais ligado ao motivo da recusa", () => {
    expect(stepForRejection("CNPJ não confere com a razão social")).toBe(3);
    expect(stepForRejection("Nome completo diferente do documento")).toBe(3);
    expect(stepForRejection("Instagram não encontrado")).toBe(4);
    expect(stepForRejection("Telefone sem DDD")).toBe(4);
    expect(stepForRejection("Descrição muito genérica")).toBe(2);
    expect(stepForRejection("Cadastro como pessoa física, mas é uma empresa")).toBe(1);
    expect(stepForRejection("Faltam informações")).toBeNull();
    expect(stepForRejection(null)).toBeNull();
  });

  it("a área escolhida pelo admin decide o passo do reenvio", () => {
    expect(stepForReviewArea("PROFILE")).toBe(1);
    expect(stepForReviewArea("BRAND")).toBe(2);
    expect(stepForReviewArea("LEGAL")).toBe(3);
    expect(stepForReviewArea("CONTACT")).toBe(4);
    expect(stepForReviewArea("OTHER")).toBeNull();
    expect(stepForReviewArea(null)).toBeNull();
  });

  it("o rascunho nunca guarda CPF/CNPJ nem o nome legal e expira", () => {
    const draft = toDraft(3, complete, 1000);
    const raw = JSON.stringify(draft);
    expect(raw).not.toContain("0001");
    expect(raw).not.toContain("LTDA");
    expect(parseDraft(raw, 2000)?.values).toMatchObject({ name: "Produtora Teste", contactEmail: "contato@produtora.test" });
    expect(parseDraft(raw, 1000 + DRAFT_TTL_MS + 1)).toBeNull();
    // Rascunho adulterado com documento: o campo é descartado.
    const tampered = JSON.stringify({ ...draft, values: { ...draft.values, document: "11222333000181", legalType: "X" } });
    expect(parseDraft(tampered, 2000)?.values).not.toHaveProperty("document");
    expect(parseDraft(tampered, 2000)?.values).not.toHaveProperty("legalType");
    expect(parseDraft("{não é json", 2000)).toBeNull();
  });
});
