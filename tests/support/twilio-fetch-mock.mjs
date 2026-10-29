// Loaded ONLY by the isolated browser runner through NODE_OPTIONS; never by app code.
import { createHash } from "node:crypto";
if (process.env.E2E_ISOLATED !== "1" || process.env.NODE_ENV === "production" || process.env.TWILIO_AUTH_TOKEN !== "isolated-e2e-only-token") {
  throw new Error("Twilio test transport requires the isolated test environment.");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "verify.twilio.com") return originalFetch(input, init);
  if (!url.pathname.startsWith("/v2/Services/VA" + "0".repeat(32) + "/")) throw new Error("Unexpected Twilio test service");
  const body = new URLSearchParams(init?.body);
  if (url.pathname.endsWith("/Verifications")) {
    const phone = body.get("To");
    const sid = "VE" + createHash("md5").update(phone).digest("hex");
    // Encode the phone in process-local test state; requests stay in the same Next server process.
    globalThis.__twilioE2ePhones ??= new Map();
    globalThis.__twilioE2ePhones.set(sid, phone);
    return Response.json({ sid, to: phone, status: "pending" });
  }
  if (url.pathname.endsWith("/VerificationCheck")) {
    const sid = body.get("VerificationSid");
    return Response.json({ sid, to: globalThis.__twilioE2ePhones?.get(sid), status: body.get("Code") === "123456" ? "approved" : "pending" });
  }
  throw new Error("Unexpected Twilio test endpoint");
};
