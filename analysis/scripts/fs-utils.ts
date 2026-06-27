import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseJsonOrThrow } from '../../shared/error-message.js';

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function readJsonFile<TValue>(filePath: string): Promise<TValue> {
  return parseJsonOrThrow<TValue>(await fs.readFile(filePath, 'utf8'), filePath);
}

export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
