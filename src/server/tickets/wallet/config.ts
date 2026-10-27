// Configuração das carteiras digitais (Apple Wallet e Google Wallet). Cada uma
// fica desligada até que todas as suas variáveis estejam preenchidas
// (docs/wallet.md): sem elas, os botões e anexos simplesmente não aparecem.
import "server-only";
import type { Env } from "../../env";

export interface AppleWalletConfig {
  passTypeIdentifier: string;
  teamIdentifier: string;
  signerCert: string;
  signerKey: string;
  signerKeyPassphrase?: string;
  wwdr: string;
}

export interface GoogleWalletConfig {
  issuerId: string;
  serviceAccountEmail: string;
  privateKey: string;
}

/** Aceita PEM direto (com "\n" escapado, comum em variáveis de ambiente) ou PEM em base64. */
export function pemFromEnv(value: string): string {
  const v = value.trim();
  if (v.includes("-----BEGIN")) return v.replace(/\\n/g, "\n");
  return Buffer.from(v, "base64").toString("utf8").trim();
}

const filled = (v: string | undefined): v is string => Boolean(v?.trim());

export function appleWalletConfig(e: Env): AppleWalletConfig | null {
  const { APPLE_WALLET_PASS_TYPE_ID: id, APPLE_WALLET_TEAM_ID: team, APPLE_WALLET_SIGNER_CERT: cert, APPLE_WALLET_SIGNER_KEY: key, APPLE_WALLET_WWDR_CERT: wwdr } = e;
  if (!filled(id) || !filled(team) || !filled(cert) || !filled(key) || !filled(wwdr)) return null;
  return {
    passTypeIdentifier: id.trim(),
    teamIdentifier: team.trim(),
    signerCert: pemFromEnv(cert),
    signerKey: pemFromEnv(key),
    signerKeyPassphrase: e.APPLE_WALLET_SIGNER_KEY_PASSPHRASE || undefined,
    wwdr: pemFromEnv(wwdr),
  };
}

export function googleWalletConfig(e: Env): GoogleWalletConfig | null {
  const { GOOGLE_WALLET_ISSUER_ID: issuer, GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: email, GOOGLE_WALLET_PRIVATE_KEY: key } = e;
  if (!filled(issuer) || !filled(email) || !filled(key)) return null;
  return { issuerId: issuer.trim(), serviceAccountEmail: email.trim(), privateKey: pemFromEnv(key) };
}
