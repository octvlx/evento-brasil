import "server-only";
import { env } from "../env";
import { AppError } from "../errors";

export interface PhoneVerificationProvider {
  start(phone: string): Promise<string>;
  check(verificationSid: string, phone: string, code: string): Promise<boolean>;
}

/** Provider responses and errors must never reach client responses or logs. */
export class TwilioVerifyProvider implements PhoneVerificationProvider {
  private config() {
    const e = env();
    if (!/^AC[0-9a-f]{32}$/i.test(e.TWILIO_ACCOUNT_SID ?? "") || !/^VA[0-9a-f]{32}$/i.test(e.TWILIO_VERIFY_SERVICE_SID ?? "") || !e.TWILIO_AUTH_TOKEN) {
      throw new AppError("PROVIDER_ERROR", "A verificação por SMS está indisponível. Tente novamente mais tarde.");
    }
    return { account: e.TWILIO_ACCOUNT_SID!, service: e.TWILIO_VERIFY_SERVICE_SID!, secret: e.TWILIO_AUTH_TOKEN };
  }
  private async request(path: string, data: Record<string, string>) {
    const c = this.config();
    try {
      const r = await fetch(`https://verify.twilio.com/v2/Services/${c.service}/${path}`, {
        method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${c.account}:${c.secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(data), signal: AbortSignal.timeout(10_000), cache: "no-store",
      });
      if (!r.ok) {
        if (r.status === 429) throw new AppError("RATE_LIMITED", "Muitas tentativas. Aguarde antes de tentar novamente.");
        if (r.status === 404) throw new AppError("VALIDATION", "Código expirado. Solicite um novo código.");
        throw new AppError("PROVIDER_ERROR", "Não foi possível verificar o celular. Tente novamente mais tarde.");
      }
      return await r.json() as { sid?: string; status?: string; to?: string };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PROVIDER_ERROR", "Não foi possível verificar o celular. Tente novamente mais tarde.");
    }
  }
  async start(phone: string) {
    const r = await this.request("Verifications", { To: phone, Channel: "sms", Locale: "pt-BR" });
    if (!/^VE[0-9a-f]{32}$/i.test(r.sid ?? "") || r.status !== "pending" || r.to !== phone) throw new AppError("PROVIDER_ERROR", "Não foi possível enviar o código. Tente novamente mais tarde.");
    return r.sid!;
  }
  async check(verificationSid: string, phone: string, code: string) {
    const r = await this.request("VerificationCheck", { VerificationSid: verificationSid, Code: code });
    return r.status === "approved" && r.sid === verificationSid && r.to === phone;
  }
}
