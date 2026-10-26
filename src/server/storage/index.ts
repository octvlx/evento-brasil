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
