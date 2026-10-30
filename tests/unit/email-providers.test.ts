import { beforeEach, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));
import { ResendEmailAdapter, ConsoleEmailAdapter } from "@/server/email";
import { authEmail, transactionalEmail } from "@/server/email/templates";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
const message = {
  to: "recipient@example.com",
  subject: "Teste",
  html: "<p>Teste</p>",
  text: "Teste",
};
beforeEach(() => {
  send.mockReset();
});
it("uses official SDK reply-to, attachments and stable provider idempotency", async () => {
  send.mockResolvedValue({ data: { id: "email-id" }, error: null });
  const provider = new ResendEmailAdapter(
    "test-key",
    "Evento <onboarding@resend.dev>",
    "reply@example.com",
  );
  expect(
    await provider.send(
      {
        ...message,
        attachments: [
          {
            filename: "ticket.pdf",
            content: new Uint8Array([1, 2]),
            contentType: "application/pdf",
          },
        ],
      },
      { idempotencyKey: "event/123" },
    ),
  ).toEqual({ id: "email-id" });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      replyTo: "reply@example.com",
      to: [message.to],
      attachments: [expect.objectContaining({ filename: "ticket.pdf" })],
    }),
    expect.objectContaining({
      idempotencyKey: "event/123",
      signal: expect.any(AbortSignal),
    }),
  );
});
it("sanitizes forbidden-recipient and transient provider failures", async () => {
  const provider = new ResendEmailAdapter("test-key", "onboarding@resend.dev");
  send.mockResolvedValue({
    data: null,
    error: { statusCode: 403, message: "sensitive provider details" },
  });
  await expect(provider.send(message)).rejects.toMatchObject({
    code: "RECIPIENT_OR_DOMAIN_UNAUTHORIZED",
    retryable: false,
  });
  send.mockRejectedValue(Error("secret"));
  await expect(provider.send(message)).rejects.toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
    retryable: true,
  });
});
it("writes a locally readable console preview without API credentials or network", async () => {
  const key = "test-console-" + Date.now();
  const provider = new ConsoleEmailAdapter();
  await provider.send(message, { idempotencyKey: key });
  const file = path.resolve(".data/outbox/" + key + ".html");
  expect(await readFile(file, "utf8")).toBe(message.html);
  await unlink(file);
  await unlink(path.resolve(".data/outbox/" + key + ".txt"));
  expect(send).not.toHaveBeenCalled();
});
it("renders branded responsive templates with escaped event data and matching text", () => {
  const email = authEmail(
    "verify",
    "http://localhost/confirmar-email#token=test",
    30,
  );
  expect(email.subject).toBe("Confirme seu e-mail | Evento Brasil");
  expect(email.html).toContain("max-width:600px");
  expect(email.text).toContain("30 minutos");
  expect(
    transactionalEmail("cancelled", "<script>", [], "https://example.com").html,
  ).not.toContain("<script>");
});
