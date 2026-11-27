import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyUserDataDir } from '../../src/main/storage/legacyDataMigration';
import {
  DATABASE_FILENAME,
  ENCRYPTED_KEY_FILENAME,
  LEGACY_DATABASE_FILENAME,
  LEGACY_USER_DATA_DIRNAME,
} from '../../src/shared/constants';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashare-volpulse-migration-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migrateLegacyUserDataDir', () => {
  it('copies legacy database, WAL sidecars, and encrypted key when new userData is empty, without overwriting existing files', () => {
    const root = createTempRoot();
    const legacyDir = path.join(root, LEGACY_USER_DATA_DIRNAME);
    const newDir = path.join(root, 'ashare-volpulse');
    fs.mkdirSync(legacyDir, { recursive: true });

    const legacyDb = path.join(legacyDir, LEGACY_DATABASE_FILENAME);
    fs.writeFileSync(legacyDb, 'legacy-sqlite-bytes');
    fs.writeFileSync(`${legacyDb}-wal`, 'legacy-wal-bytes');
    fs.writeFileSync(`${legacyDb}-shm`, 'legacy-shm-bytes');
    fs.writeFileSync(path.join(legacyDir, ENCRYPTED_KEY_FILENAME), 'legacy-enc-key');

    const first = migrateLegacyUserDataDir(newDir);
    expect(first).toEqual({ migratedDatabase: true, migratedSecretKey: true });

    const targetDb = path.join(newDir, DATABASE_FILENAME);
    expect(fs.readFileSync(targetDb, 'utf8')).toBe('legacy-sqlite-bytes');
    expect(fs.readFileSync(`${targetDb}-wal`, 'utf8')).toBe('legacy-wal-bytes');
    expect(fs.readFileSync(`${targetDb}-shm`, 'utf8')).toBe('legacy-shm-bytes');
    expect(fs.readFileSync(path.join(newDir, ENCRYPTED_KEY_FILENAME), 'utf8')).toBe(
      'legacy-enc-key'
    );
    // 原旧目录文件保持完好不删除
    expect(fs.existsSync(legacyDb)).toBe(true);

    // 新库已存在后再次运行绝不覆盖（幂等）
    fs.writeFileSync(targetDb, 'new-sqlite-bytes');
    const second = migrateLegacyUserDataDir(newDir);
    expect(second).toEqual({ migratedDatabase: false, migratedSecretKey: false });
    expect(fs.readFileSync(targetDb, 'utf8')).toBe('new-sqlite-bytes');
  });
});
