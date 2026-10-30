import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { enqueueEmail } from "@/server/email/outbox";
import { db, resetDb } from "../support/fixtures";

beforeEach(resetDb);

function cli(script: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      "--conditions=react-server",
      path.resolve("scripts", script),
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        EMAIL_PROVIDER: "console",
        RESEND_API_KEY: "",
        EMAIL_API_KEY: "",
      },
    },
  );
}

it("runs the documented worker/status/retry CLIs in separate processes and preserves delivery state", async () => {
  const add = (dedupeKey: string, expiresAt?: Date) =>
    enqueueEmail(db, {
      dedupeKey,
      template: "CLI_REGRESSION",
      recipient: "cli@test.local",
      expiresAt,
      message: {
        subject: "Teste CLI",
        html: "<p>Teste local</p>",
        text: "Teste local",
      },
    });
  const valid = await add("cli-valid");
  const expired = await add("cli-expired", new Date(0));
  const retry = await add("cli-retry");
  await db.emailOutbox.update({
    where: { id: retry.id },
    data: {
      status: "FAILED",
      attemptCount: 1,
      firstAttemptAt: new Date(),
      errorCode: "TEST_FAILURE",
    },
  });
  const initial = cli("email-status.ts");
  expect(initial.status).toBe(0);
  expect(initial.stdout).toContain("QUEUED");
  expect(initial.stdout).toContain("FAILED");
  expect(cli("email-worker.ts").status).toBe(0);
  expect(
    await db.emailOutbox.findUniqueOrThrow({ where: { id: valid.id } }),
  ).toMatchObject({
    status: "SENT",
    provider: "console",
    attemptCount: 1,
    messageEncrypted: null,
    providerMessageId: expect.stringMatching(/^console:/),
    sentAt: expect.any(Date),
  });
  expect(
    (await db.emailOutbox.findUniqueOrThrow({ where: { id: expired.id } }))
      .status,
  ).toBe("CANCELLED");
  expect(cli("email-retry.ts", retry.id).status).toBe(0);
  expect(cli("email-worker.ts").status).toBe(0);
  expect(cli("email-worker.ts").stdout).toContain('"sent":0');
  expect(
    await db.emailOutbox.findUniqueOrThrow({ where: { id: retry.id } }),
  ).toMatchObject({
    status: "SENT",
    attemptCount: 2,
    messageEncrypted: null,
  });
  expect(
    (await db.emailOutbox.findUniqueOrThrow({ where: { id: valid.id } }))
      .attemptCount,
  ).toBe(1);
  expect(cli("email-retry.ts", valid.id).status).toBe(1);
});
