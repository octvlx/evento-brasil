// Publica as versões dos documentos legais (src/content/legal) como TermsVersion.
//
//   npm run terms:publish            → só mostra o que seria gravado (nada muda)
//   npm run terms:publish -- --apply → grava as versões que ainda não existem
//
// Recusa gravar enquanto houver "[A PREENCHER: …]" no texto. Versão já existente
// (mesmo tipo e número) não é regravada: texto novo exige número de versão novo, e
// a versão nova passa a exigir reaceite dos usuários (src/server/services/terms.ts).
import "dotenv/config";
import { LEGAL_DOCUMENTS, legalDocumentHash, pendingPlaceholders } from "@/content/legal";
import { createPrismaClient } from "@/server/db";
import { dbTarget } from "./db-target.mjs";

async function main() {
  const apply = process.argv.includes("--apply");
  const target = dbTarget();
  console.log(`Banco: ${target.label}${target.isLocal ? " (local)" : ""}`);

  const pending = LEGAL_DOCUMENTS.map((doc) => ({ doc, missing: pendingPlaceholders(doc) }));
  for (const { doc, missing } of pending) {
    console.log(`\n${doc.kind} ${doc.version} (${doc.path})\n  hash: ${legalDocumentHash(doc)}`);
    if (missing.length) console.log(`  falta preencher: ${missing.join(", ")}`);
  }
  if (pending.some((p) => p.missing.length)) {
    console.error("\nHá campos a preencher em src/content/legal/company.ts. Nada foi gravado.");
    process.exitCode = 1;
    return;
  }

  const db = createPrismaClient();
  try {
    const publishedAt = new Date();
    for (const doc of LEGAL_DOCUMENTS) {
      const textHash = legalDocumentHash(doc);
      const existing = await db.termsVersion.findUnique({ where: { kind_version: { kind: doc.kind, version: doc.version } } });
      if (existing) {
        const same = existing.textHash === textHash;
        console.log(`${doc.kind} ${doc.version}: já publicada${same ? "" : " COM OUTRO TEXTO: aumente o número da versão para publicar o texto atual"}.`);
        if (!same) process.exitCode = 1;
        continue;
      }
      if (!apply) {
        console.log(`${doc.kind} ${doc.version}: seria publicada.`);
        continue;
      }
      await db.termsVersion.create({ data: { kind: doc.kind, version: doc.version, textHash, documentPath: doc.path, isDraft: false, publishedAt } });
      console.log(`${doc.kind} ${doc.version}: publicada.`);
    }
    if (!apply) console.log("\nSimulação: nada foi gravado. Use --apply para publicar.");
  } finally {
    await db.$disconnect();
  }
}

void main();
