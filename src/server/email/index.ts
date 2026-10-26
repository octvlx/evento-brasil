import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Uint8Array; contentType: string }[];
}

export interface EmailAdapter {
  readonly id: string;
  send(msg: EmailMessage): Promise<void>;
}

/** Desenvolvimento: grava as mensagens em .data/outbox (não envia nada). */
class ConsoleEmailAdapter implements EmailAdapter {
  readonly id = "console";
  async send(msg: EmailMessage) {
    const dir = path.resolve(".data/outbox");
    await mkdir(dir, { recursive: true });
    const base = `${new Date().toISOString().replace(/[:.]/g, "-")}-${msg.to.replace(/[^a-z0-9@.]/gi, "_")}`;
    await writeFile(path.join(dir, `${base}.html`), msg.html);
    for (const a of msg.attachments ?? []) await writeFile(path.join(dir, `${base}-${a.filename}`), a.content);
    console.info(`[email:console] para=${msg.to} assunto="${msg.subject}" anexos=${msg.attachments?.length ?? 0} → ${dir}`);
  }
}

/**
 * Resend (HTTP API). Implementado conforme a documentação pública
 * (POST /emails com anexos em base64), mas NÃO verificado neste ambiente.
 */
class ResendEmailAdapter implements EmailAdapter {
  readonly id = "resend";
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  async send(msg: EmailMessage) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") })),
      }),
    });
    if (!res.ok) throw new Error(`Falha ao enviar e-mail (${res.status})`);
  }
}

let adapter: EmailAdapter | undefined;
export function getEmailAdapter(): EmailAdapter {
  if (adapter) return adapter;
  const e = env();
  if (e.EMAIL_PROVIDER === "resend") {
    if (!e.EMAIL_API_KEY) throw new Error("EMAIL_API_KEY não configurada");
    adapter = new ResendEmailAdapter(e.EMAIL_API_KEY, e.EMAIL_FROM);
  } else adapter = new ConsoleEmailAdapter();
  return adapter;
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
