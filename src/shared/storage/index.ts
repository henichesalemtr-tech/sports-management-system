import { mkdir, readFile as fsReadFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getEnv } from '@/shared/config/env';

export interface StoredFile { storageKey: string; mimeType: string; sizeBytes: number; }
interface StoreOptions { kind?: 'image' | 'document'; declaredMime?: string; subdir?: string; }

function detect(buffer: Buffer, declaredMime?: string): { mimeType: string; extension: string } | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: 'image/png', extension: 'png' };
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return { mimeType: 'application/pdf', extension: 'pdf' };
  if (buffer.subarray(0, 2).toString('ascii') === 'PK') return { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
  if (declaredMime === 'text/csv' || declaredMime === 'application/csv') return { mimeType: 'text/csv', extension: 'csv' };
  return null;
}

async function store(buffer: Buffer, options: StoreOptions = {}): Promise<StoredFile> {
  const env = getEnv();
  if (env.STORAGE_DRIVER !== 'local') throw new Error('S3 storage driver is not configured in this deployment');
  const detected = detect(buffer, options.declaredMime);
  if (!detected) throw new Error('UNSUPPORTED_FILE: نوع الملف غير مدعوم أو لا يطابق محتواه');
  const isImage = detected.mimeType.startsWith('image/');
  if (options.kind === 'image' && !isImage) throw new Error('UNSUPPORTED_FILE: ملف الصورة غير صالح');
  if (options.kind === 'document' && isImage === false && detected.mimeType !== 'application/pdf') throw new Error('UNSUPPORTED_FILE: الوثائق المدعومة PDF أو صورة');
  const maxMb = options.kind === 'image' ? env.STORAGE_MAX_IMAGE_MB : env.STORAGE_MAX_DOCUMENT_MB;
  if (buffer.byteLength > maxMb * 1024 * 1024) throw new Error('FILE_TOO_LARGE: حجم الملف أكبر من الحد المسموح');
  const relative = path.join(options.subdir ?? 'uploads', `${randomUUID()}.${detected.extension}`);
  const absolute = path.resolve(env.STORAGE_LOCAL_DIR, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer, { flag: 'wx' });
  return { storageKey: relative.split(path.sep).join('/'), mimeType: detected.mimeType, sizeBytes: buffer.byteLength };
}

export function storeFile(buffer: Buffer, options: StoreOptions = {}): Promise<StoredFile> {
  return store(buffer, options);
}

export function storeImportFile(buffer: Buffer, originalName: string): Promise<StoredFile> {
  const lower = originalName.toLowerCase();
  const declared = lower.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return store(buffer, { declaredMime: declared, subdir: 'imports' });
}

export async function readFile(storageKey: string): Promise<Buffer> {
  const env = getEnv();
  const root = path.resolve(env.STORAGE_LOCAL_DIR);
  const absolute = path.resolve(root, storageKey);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error('INVALID_STORAGE_KEY');
  return fsReadFile(absolute);
}
