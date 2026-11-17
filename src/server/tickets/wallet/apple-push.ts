// Aviso de atualização de passes da Apple Wallet: push vazio pelo APNs (HTTP/2), com o
// mesmo certificado do Pass Type ID e o Pass Type ID como tópico. O aparelho então
// consulta o web service (passes.ts) e baixa o passe novo.
import "server-only";
import http2 from "node:http2";
import type { AppleWalletConfig } from "./config";

const APNS_HOST = "https://api.push.apple.com";

export interface ApplePushResult {
  /** Tokens aceitos pelo APNs. */
  sent: string[];
  /** Tokens que não valem mais (410): o registro do aparelho deve ser apagado. */
  gone: string[];
  /** Falhas a tentar de novo depois. */
  failed: string[];
}

export type ApplePushSender = (cfg: AppleWalletConfig, pushTokens: string[]) => Promise<ApplePushResult>;

export const sendApplePassPushes: ApplePushSender = async (cfg, pushTokens) => {
  const result: ApplePushResult = { sent: [], gone: [], failed: [] };
  if (!pushTokens.length) return result;
  const client = http2.connect(APNS_HOST, { cert: cfg.signerCert, key: cfg.signerKey, passphrase: cfg.signerKeyPassphrase });
  client.on("error", () => {});
  try {
    await Promise.all(
      pushTokens.map(
        (token) =>
          new Promise<void>((resolve) => {
            const req = client.request({
              ":method": "POST",
              ":path": `/3/device/${encodeURIComponent(token)}`,
              "apns-topic": cfg.passTypeIdentifier,
              "content-type": "application/json",
            });
            req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
            let status = 0;
            req.on("response", (headers) => (status = Number(headers[":status"])));
            req.on("data", () => {});
            req.on("close", () => {
              if (status === 200) result.sent.push(token);
              // Só 410 apaga o registro: um 400 pode ser configuração errada (tópico,
              // certificado) e apagaria todos os aparelhos.
              else if (status === 410) result.gone.push(token);
              else result.failed.push(token);
              resolve();
            });
            req.on("error", () => {});
            req.end("{}");
          }),
      ),
    );
  } finally {
    client.close();
  }
  return result;
};
