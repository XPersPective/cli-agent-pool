import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { PoolError } from './config.js';

function secretsDir(directory) {
  const dir = path.join(directory, 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new PoolError('UNSAFE_DATA_DIRECTORY', 'Gizli anahtar klasörü sembolik bağlantı olamaz.');
  return dir;
}

function validateRef(secretRef) {
  if (typeof secretRef !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(secretRef)) {
    throw new PoolError('INVALID_SECRET_REF', 'Gizli anahtar referansı geçersiz.');
  }
}

export function saveSecret(directory, secretRef, value) {
  validateRef(secretRef);
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PoolError('INVALID_SECRET', 'API anahtarı geçersiz veya boş.');
  }
  const dir = secretsDir(directory);
  const filename = path.join(dir, `${secretRef}.key`);
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, value.trim() + '\n');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function hasSecret(directory, secretRef) {
  validateRef(secretRef);
  const filename = path.join(directory, 'secrets', `${secretRef}.key`);
  return existsSync(filename) && lstatSync(filename).isFile();
}

export function loadSecret(directory, secretRef) {
  validateRef(secretRef);
  const filename = path.join(directory, 'secrets', `${secretRef}.key`);
  if (!existsSync(filename) || !lstatSync(filename).isFile()) {
    throw new PoolError('SECRET_MISSING', 'Bu API bağlantısı için kayıtlı anahtar bulunamadı. Panelden anahtarı kaydedin.');
  }
  const value = readFileSync(filename, 'utf8').trim();
  if (!value) throw new PoolError('SECRET_MISSING', 'Kayıtlı API anahtarı boş.');
  return value;
}

export function deleteSecret(directory, secretRef) {
  validateRef(secretRef);
  const filename = path.join(directory, 'secrets', `${secretRef}.key`);
  if (existsSync(filename)) unlinkSync(filename);
}
