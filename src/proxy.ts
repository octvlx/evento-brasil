// Modo de manutenção: com MAINTENANCE_MODE=true, as páginas respondem uma tela de
// manutenção (503) e as APIs um JSON 503, exceto as rotas sempre liberadas em
// src/server/maintenance.ts. Desligado, o proxy só deixa passar. Guia: docs/manutencao.md.
import { NextResponse, type NextRequest } from "next/server";
import {
  MAINTENANCE_MESSAGE,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  maintenanceConfig,
  maintenanceDecision,
  maintenanceHtml,
} from "@/server/maintenance";

export function proxy(request: NextRequest) {
  const decision = maintenanceDecision(request.nextUrl.pathname, maintenanceConfig());
  if (decision === "open") return NextResponse.next();

  const headers = {
    "Retry-After": String(MAINTENANCE_RETRY_AFTER_SECONDS),
    "Cache-Control": "no-store",
  };
  if (decision === "api") {
    return Response.json({ error: "MAINTENANCE", message: MAINTENANCE_MESSAGE }, { status: 503, headers });
  }
  return new Response(request.method === "HEAD" ? null : maintenanceHtml, {
    status: 503,
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}

export const config = {
  // Arquivos estáticos, imagens otimizadas e ícones passam direto (a tela não os usa,
  // mas o navegador os pede).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|icons/).*)"],
};
