/** 备份加密元数据（OPT-20 使用明文 manifest 记录，口令本身不落盘） */
export interface BackupEncryptionMeta {
    algorithm: 'aes-256-gcm';
    kdf: 'scrypt';
    salt: string;
    keyCheck: string;
    scryptParams: {
        N: number;
        r: number;
        p: number;
    };
}

export interface BackupEntryDigest {
    size: number;
    sha256: string;
}

export interface BackupUserMeta {
    id: string;
    email: string;
    name: string | null;
    educationStage: string | null;
    enrollmentYear: number | null;
    gradeRecognitionMode: string;
    fixedGradeSemester: string | null;
    role: string;
    confirmBeforeImport: boolean;
    questionDuplicateThreshold: number;
    masteryThreshold: number;
    enableGeogebra: boolean;
    enableSvgAnimation: boolean;
    variantPipelineEnabled: boolean;
    themePreference: string;
}

export interface BackupManifestV3 {
    formatVersion: 3;
    appVersion: string;
    exportedAt: string;
    scope: 'user' | 'all';
    user: BackupUserMeta;
    /** 核心业务记录计数 */
    counts: Record<string, number>;
    /** 可重算的派生学习状态计数 */
    derivedCounts: Record<string, number>;
    /** ZIP 内除 manifest.json 外的每个条目字节数与 SHA-256 摘要 */
    files: Record<string, BackupEntryDigest>;
    warnings: string[];
    encryption?: BackupEncryptionMeta;
}

export interface ImportStatsV3 {
    learnersCreated: number;
    gradingClassesCreated: number;
    gradingStudentsCreated: number;
    subjectsCreated: number;
    tagsCreated: number;
    errorItemsCreated: number;
    reviewSchedulesCreated: number;
    examPapersCreated: number;
    preferencesRestored: boolean;
    practiceRecordsCreated: number;
    parentPapersCreated: number;
    gradingTasksCreated: number;
    variantRunsCreated: number;
    knowledgeMasteriesImported: number;
    learningPathsCreated: number;
    tagsLinked: number;
    duplicateErrorItems: number;
    ttsSpeechesImported: number;
}

export type EntryTransform = (entryName: string, plain: Uint8Array) => Uint8Array;
