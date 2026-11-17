import crypto from 'node:crypto';
import {
    BackupFormatError,
    BackupInvalidPassphraseError,
    BackupPassphraseRequiredError,
} from '@/lib/backup/errors';
import type { BackupEncryptionMeta, EntryTransform } from '@/lib/backup/types';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const MAX_SCRYPT_N = 65536;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 4;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_CHECK_PLAINTEXT = 'xueji-backup-v3-keycheck';
const KEY_CHECK_AAD = Buffer.from('manifest:keycheck', 'utf8');

function isPowerOfTwo(value: number): boolean {
    return Number.isInteger(value) && value >= 1024 && (value & (value - 1)) === 0;
}

function validateEncryptionMeta(meta: BackupEncryptionMeta): { N: number; r: number; p: number } {
    if (meta.algorithm !== 'aes-256-gcm' || meta.kdf !== 'scrypt') {
        throw new BackupFormatError('Unsupported backup encryption algorithm');
    }
    const params = meta.scryptParams;
    if (
        !params
        || !isPowerOfTwo(params.N)
        || params.N > MAX_SCRYPT_N
        || !Number.isInteger(params.r) || params.r < 1 || params.r > MAX_SCRYPT_R
        || !Number.isInteger(params.p) || params.p < 1 || params.p > MAX_SCRYPT_P
    ) {
        throw new BackupFormatError('Invalid backup encryption parameters');
    }
    if (typeof meta.salt !== 'string' || !meta.salt || typeof meta.keyCheck !== 'string' || !meta.keyCheck) {
        throw new BackupFormatError('Incomplete backup encryption metadata');
    }
    return params;
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
    return crypto.scryptSync(passphrase.normalize('NFKC'), salt, KEY_LENGTH, {
        ...params,
        maxmem: 128 * 1024 * 1024,
    });
}

function sealBytes(key: Buffer, aad: Buffer, plain: Uint8Array): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]);
}

function openBytes(key: Buffer, aad: Buffer, packed: Uint8Array): Buffer {
    if (packed.byteLength < IV_LENGTH + TAG_LENGTH) {
        throw new Error('Ciphertext too short');
    }
    const buf = Buffer.isBuffer(packed) ? packed : Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength);
    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 为 v3 ZIP 导出生成 AES-256-GCM 加密元数据及逐条目变换函数 */
export function prepareBackupEncryption(passphrase: string): {
    meta: BackupEncryptionMeta;
    transformEntry: EntryTransform;
} {
    if (!passphrase) {
        throw new BackupPassphraseRequiredError();
    }
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(passphrase, salt, SCRYPT_PARAMS);
    const keyCheck = sealBytes(key, KEY_CHECK_AAD, Buffer.from(KEY_CHECK_PLAINTEXT, 'utf8')).toString('base64');

    const meta: BackupEncryptionMeta = {
        algorithm: 'aes-256-gcm',
        kdf: 'scrypt',
        salt: salt.toString('base64'),
        keyCheck,
        scryptParams: { ...SCRYPT_PARAMS },
    };

    const transformEntry: EntryTransform = (entryName, plain) => (
        sealBytes(key, Buffer.from(entryName, 'utf8'), plain)
    );

    return { meta, transformEntry };
}

/** 校验导入端提供的口令与 manifest.encryption，并返回逐条目解密函数 */
export function createBackupEntryDecryptor(
    meta: BackupEncryptionMeta,
    passphrase: string | undefined,
): EntryTransform {
    const params = validateEncryptionMeta(meta);
    if (!passphrase) {
        throw new BackupPassphraseRequiredError();
    }
    const salt = Buffer.from(meta.salt, 'base64');
    const keyCheckPacked = Buffer.from(meta.keyCheck, 'base64');
    const key = deriveKey(passphrase, salt, params);

    try {
        const verified = openBytes(key, KEY_CHECK_AAD, keyCheckPacked);
        const expected = Buffer.from(KEY_CHECK_PLAINTEXT, 'utf8');
        if (verified.byteLength !== expected.byteLength || !crypto.timingSafeEqual(verified, expected)) {
            throw new BackupInvalidPassphraseError();
        }
    } catch (error) {
        if (error instanceof BackupInvalidPassphraseError) throw error;
        throw new BackupInvalidPassphraseError();
    }

    return (entryName, packed) => {
        try {
            return openBytes(key, Buffer.from(entryName, 'utf8'), packed);
        } catch {
            throw new BackupFormatError(`Encrypted backup entry integrity check failed: ${entryName}`);
        }
    };
}
