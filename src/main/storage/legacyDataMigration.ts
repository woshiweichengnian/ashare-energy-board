import fs from 'node:fs';
import path from 'node:path';
import {
  DATABASE_FILENAME,
  ENCRYPTED_KEY_FILENAME,
  LEGACY_DATABASE_FILENAME,
  LEGACY_USER_DATA_DIRNAME,
} from '../../shared/constants';

export interface LegacyMigrationResult {
  migratedDatabase: boolean;
  migratedSecretKey: boolean;
}

/**
 * 项目由 a-share-monitor 更名为 ashare-volpulse 后的平滑只读拷贝迁移：
 * - 仅在新 userData 目录尚无目标文件、且同级旧目录存在历史数据时执行一次（幂等，绝不覆盖新库）
 * - 连同 SQLite WAL 伴随文件（-wal / -shm）与加密凭据文件一并复制，原旧目录保留不删以便回退
 */
export function migrateLegacyUserDataDir(userDataDir: string): LegacyMigrationResult {
  const result: LegacyMigrationResult = {
    migratedDatabase: false,
    migratedSecretKey: false,
  };

  const parentDir = path.dirname(userDataDir);
  const legacyDir = path.join(parentDir, LEGACY_USER_DATA_DIRNAME);
  if (path.resolve(legacyDir) === path.resolve(userDataDir) || !fs.existsSync(legacyDir)) {
    return result;
  }

  const targetDbPath = path.join(userDataDir, DATABASE_FILENAME);
  const legacyDbPath = path.join(legacyDir, LEGACY_DATABASE_FILENAME);
  if (!fs.existsSync(targetDbPath) && fs.existsSync(legacyDbPath)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.copyFileSync(legacyDbPath, targetDbPath);
    for (const suffix of ['-wal', '-shm']) {
      const legacySidecar = `${legacyDbPath}${suffix}`;
      if (fs.existsSync(legacySidecar)) {
        fs.copyFileSync(legacySidecar, `${targetDbPath}${suffix}`);
      }
    }
    result.migratedDatabase = true;
  }

  const targetKeyPath = path.join(userDataDir, ENCRYPTED_KEY_FILENAME);
  const legacyKeyPath = path.join(legacyDir, ENCRYPTED_KEY_FILENAME);
  if (!fs.existsSync(targetKeyPath) && fs.existsSync(legacyKeyPath)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.copyFileSync(legacyKeyPath, targetKeyPath);
    result.migratedSecretKey = true;
  }

  return result;
}
