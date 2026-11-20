export class BackupError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(code: string, message: string, status = 400) {
        super(message);
        this.name = 'BackupError';
        this.code = code;
        this.status = status;
    }
}

export class BackupFormatError extends BackupError {
    constructor(message = 'Invalid backup archive format', code = 'INVALID_BACKUP') {
        super(code, message, 400);
        this.name = 'BackupFormatError';
    }
}

export class BackupOwnershipError extends BackupError {
    constructor(message = 'Import data does not belong to current user') {
        super('BACKUP_OWNER_MISMATCH', message, 400);
        this.name = 'BackupOwnershipError';
    }
}

export class BackupPassphraseRequiredError extends BackupError {
    constructor(message = 'Backup passphrase is required') {
        super('BACKUP_PASSPHRASE_REQUIRED', message, 400);
        this.name = 'BackupPassphraseRequiredError';
    }
}

export class BackupInvalidPassphraseError extends BackupError {
    constructor(message = 'Incorrect backup passphrase') {
        super('BACKUP_INVALID_PASSPHRASE', message, 400);
        this.name = 'BackupInvalidPassphraseError';
    }
}
