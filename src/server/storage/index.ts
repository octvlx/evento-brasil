import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomToken } from "../crypto";
import { env } from "../env";
import { AppError } from "../errors";

export interface StorageAdapter {
  readonly id: string;
  put(key: string, body: Uint8Array, contentType: string): Promise<{ key: string; url: string }>;
}

const LOCAL_ROOT = path.resolve(".data/uploads");

/** Desenvolvimento: grava em .data/uploads e serve por /uploads/[...key]. */
class LocalStorage implements StorageAdapter {
  readonly id = "local";
  async put(key: string, body: Uint8Array) {
    const file = path.join(LOCAL_ROOT, key);
    if (!file.startsWith(LOCAL_ROOT)) throw new Error("Chave inválida");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return { key, url: `/uploads/${key}` };
  }
}

export async function readLocalUpload(key: string): Promise<Buffer | null> {
  const file = path.join(LOCAL_ROOT, key);
  if (!file.startsWith(LOCAL_ROOT + path.sep)) return null;
  return readFile(file).catch(() => null);
}

/** Qualquer serviço compatível com S3 (AWS, R2, MinIO…). Não verificado neste ambiente. */
class S3Storage implements StorageAdapter {
  readonly id = "s3";
  async put(key: string, body: Uint8Array, contentType: string) {
    const e = env();
    if (!e.OBJECT_STORAGE_BUCKET || !e.OBJECT_STORAGE_ACCESS_KEY || !e.OBJECT_STORAGE_SECRET_KEY || !e.OBJECT_STORAGE_PUBLIC_URL) {
      throw new Error("Armazenamento S3 não configurado");
    }
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: e.OBJECT_STORAGE_REGION,
      endpoint: e.OBJECT_STORAGE_ENDPOINT || undefined,
      forcePathStyle: !!e.OBJECT_STORAGE_ENDPOINT,
      credentials: { accessKeyId: e.OBJECT_STORAGE_ACCESS_KEY, secretAccessKey: e.OBJECT_STORAGE_SECRET_KEY },
    });
    await client.send(new PutObjectCommand({ Bucket: e.OBJECT_STORAGE_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }));
    return { key, url: `${e.OBJECT_STORAGE_PUBLIC_URL.replace(/\/$/, "")}/${key}` };
  }
}

export function getStorage(): StorageAdapter {
  return env().STORAGE_PROVIDER === "s3" ? new S3Storage() : new LocalStorage();
}

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Valida tipo pelo conteúdo (assinatura do arquivo), não só pelo nome. */
export function detectImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/**
 * Largura e altura lidas do cabeçalho do arquivo (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X).
 * null = arquivo truncado ou inválido. Sem dependência nova (sem decodificar a imagem).
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const type = detectImageType(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === "image/png") {
      if (bytes.length < 24) return null;
      return { width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = dv.getUint16(i + 2);
        if (len < 2) return null;
        // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (type === "image/webp") {
      const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (chunk === "VP8 " && bytes.length >= 30) return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (chunk === "VP8L" && bytes.length >= 25) {
        const b = dv.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X" && bytes.length >= 30) {
        const w = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
        const h = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
        return { width: w + 1, height: h + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Grava uma imagem já baixada/recebida, com a mesma validação do upload (tipo pelo conteúdo e tamanho). */
export async function storeImageBytes(folder: string, bytes: Uint8Array) {
  if (!/^[A-Za-z0-9_-]+$/.test(folder)) throw new AppError("VALIDATION", "Pasta inválida.");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", "Imagem muito grande (máximo 5 MB).");
  const type = detectImageType(bytes);
  if (!type) throw new AppError("VALIDATION", "O arquivo não é uma imagem JPG, PNG ou WebP válida.");
  const key = `events/${folder}/${Date.now()}-${randomToken(6)}.${IMAGE_TYPES[type]}`;
  return getStorage().put(key, bytes, type);
}

export async function storeEventImage(organizationId: string, file: File) {
  if (file.size > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", "Imagem muito grande (máximo 5 MB).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectImageType(bytes);
  if (!type) throw new AppError("VALIDATION", "Envie uma imagem JPG, PNG ou WebP.");
  const key = `events/${organizationId}/${Date.now()}-${randomToken(6)}.${IMAGE_TYPES[type]}`;
  return getStorage().put(key, bytes, type);
}

export const contentTypeForKey = (key: string) =>
  key.endsWith(".png") ? "image/png" : key.endsWith(".webp") ? "image/webp" : key.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
