import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { helpTopics } from "@/content/help";
import { CANCEL_HELP_HREF } from "@/lib/help-links";
import { ARREPENDIMENTO_DAYS } from "@/server/services/refunds";

const topics = helpTopics();
/** Âncoras fixas da página (fora do conteúdo). */
const PAGE_ANCHORS = ["contato", "solicitar-cancelamento"];

describe("Central de ajuda", () => {
  it("âncoras únicas, incluindo as usadas por links do site", () => {
    const ids = [...topics.map((t) => t.id), ...topics.flatMap((t) => t.questions.map((q) => q.id)), ...PAGE_ANCHORS];
    expect(new Set(ids).size).toBe(ids.length);
    for (const anchor of [CANCEL_HELP_HREF.split("#")[1], "transferencia", "taxas"]) expect(ids).toContain(anchor);
  });

  it("todo tema tem perguntas com resposta", () => {
    for (const t of topics) {
      expect(t.questions.length).toBeGreaterThan(0);
      for (const q of t.questions) expect(q.answer.length).toBeGreaterThan(0);
    }
  });

  it("links internos apontam para páginas ou âncoras que existem", () => {
    const ids = new Set([...topics.flatMap((t) => [t.id, ...t.questions.map((q) => q.id)]), ...PAGE_ANCHORS]);
    for (const link of topics.flatMap((t) => t.questions.flatMap((q) => q.links ?? []))) {
      if (link.href.startsWith("#")) expect(ids.has(link.href.slice(1)), link.href).toBe(true);
      else expect(existsSync(path.join("src/app", link.href, "page.tsx")), link.href).toBe(true);
    }
  });

  it("arrependimento segue a regra do sistema", () => {
    const answer = topics.find((t) => t.id === "cancelamento")!.questions.find((q) => q.id === "arrependimento")!;
    expect(answer.answer.join(" ")).toContain(`Até ${ARREPENDIMENTO_DAYS} dias depois do pagamento`);
  });
});
