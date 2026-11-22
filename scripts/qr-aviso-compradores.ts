// Aviso único do QR dinâmico aos titulares de ingressos emitidos antes da mudança (#175).
// Uso:
//   npm run email:aviso-qr              (simulação: só conta, não envia nada)
//   npm run email:aviso-qr -- --enviar  (põe os e-mails na fila; o email:worker envia)
// Nunca imprime e-mails nem nomes: só quantidades por evento.
import "dotenv/config";
import { db } from "../src/server/db";
import { dynamicQrNoticeTargets, enqueueDynamicQrNotice } from "../src/server/services/qr-notice";

async function main() {
  const send = process.argv.includes("--enviar");
  const targets = await dynamicQrNoticeTargets(db);
  const people = targets.reduce((s, t) => s + t.recipients.length, 0);
  for (const t of targets) console.log(`${t.startsAt.toISOString().slice(0, 10)}  ${t.recipients.length} pessoa(s)  ${t.eventTitle}`);
  console.log(`Total: ${targets.length} evento(s), ${people} aviso(s).`);
  if (!send) {
    console.log("Simulação: nada foi enviado. Para enviar, rode de novo com --enviar.");
    return;
  }
  const r = await enqueueDynamicQrNotice(db);
  console.log(`Na fila: ${r.queued} aviso(s). O envio é feito pelo worker (npm run email:worker). Rodar de novo não duplica.`);
}

main()
  .catch((e) => {
    console.error("Falha ao preparar os avisos:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
