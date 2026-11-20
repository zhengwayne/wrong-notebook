import { describe, expect, it } from 'vitest';
import { createBackupEntryDecryptor, prepareBackupEncryption } from '@/lib/backup/crypto';
import {
    BackupFormatError,
    BackupInvalidPassphraseError,
    BackupPassphraseRequiredError,
} from '@/lib/backup/errors';

describe('backup/crypto', () => {
    it('supports AES-256-GCM + scrypt roundtrip per entry without exposing passphrase', () => {
        const passphrase = 'correct-horse-battery-staple-密码';
        const { meta, transformEntry } = prepareBackupEncryption(passphrase);

        expect(meta.algorithm).toBe('aes-256-gcm');
        expect(meta.kdf).toBe('scrypt');
        expect(JSON.stringify(meta)).not.toContain(passphrase);

        const plain = Buffer.from('{"id":"item-1","question":"解方程 x+1=2"}\n', 'utf8');
        const packed = transformEntry('data/errorItems.ndjson', plain);
        expect(Buffer.from(packed).toString('utf8')).not.toContain('解方程');

        const decrypt = createBackupEntryDecryptor(meta, passphrase);
        const recovered = decrypt('data/errorItems.ndjson', packed);
        expect(Buffer.from(recovered).toString('utf8')).toBe(plain.toString('utf8'));
    });

    it('throws BACKUP_PASSPHRASE_REQUIRED when passphrase is missing', () => {
        const { meta } = prepareBackupEncryption('secret-123');
        expect(() => createBackupEntryDecryptor(meta, undefined)).toThrow(BackupPassphraseRequiredError);
        expect(() => createBackupEntryDecryptor(meta, '')).toThrow(BackupPassphraseRequiredError);
    });

    it('throws BACKUP_INVALID_PASSPHRASE when passphrase is wrong', () => {
        const { meta } = prepareBackupEncryption('secret-123');
        expect(() => createBackupEntryDecryptor(meta, 'wrong-pass')).toThrow(BackupInvalidPassphraseError);
    });

    it('rejects tampered ciphertext and cross-entry swapping via AAD binding', () => {
        const { meta, transformEntry } = prepareBackupEncryption('secret-123');
        const packed = Uint8Array.from(transformEntry('data/subjects.ndjson', Buffer.from('[]', 'utf8')));
        const decrypt = createBackupEntryDecryptor(meta, 'secret-123');

        // 篡改密文末尾字节
        const tampered = Uint8Array.from(packed);
        tampered[tampered.length - 1] ^= 0xff;
        expect(() => decrypt('data/subjects.ndjson', tampered)).toThrow(BackupFormatError);

        // 用其它条目名称解密（AAD 不匹配）
        expect(() => decrypt('data/users.ndjson', packed)).toThrow(BackupFormatError);
    });
});
