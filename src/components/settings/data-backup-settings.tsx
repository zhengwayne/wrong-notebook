"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, Download, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackupPassphraseField } from "@/components/settings/backup-passphrase-field";
import { DailySnapshotStatus } from "@/components/settings/daily-snapshot-status";
import { useLanguage } from "@/contexts/LanguageContext";
import { downloadFile } from "@/lib/download-file";
import { confirmDialog, toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import type { Translations } from "@/lib/translations";

type ImportStats = Record<string, number | boolean | undefined>;

function formatImportResult(stats: ImportStats, t: Translations): string {
    return (t.settings?.importResultDesc || "Imported {subjects} notebooks, {tags} tags, {items} error items, {schedules} review schedules, {records} practice records, {papers} exam papers and {voices} cloud voice clips.")
        .replace('{subjects}', String(stats.subjectsCreated ?? 0))
        .replace('{tags}', String(stats.tagsCreated ?? 0))
        .replace('{items}', String(stats.errorItemsCreated ?? 0))
        .replace('{schedules}', String(stats.reviewSchedulesCreated ?? 0))
        .replace('{records}', String(stats.practiceRecordsCreated ?? 0))
        .replace('{papers}', String(stats.examPapersCreated ?? 0))
        .replace('{voices}', String(stats.ttsSpeechesImported ?? 0))
        .replace('{duplicates}', String(stats.duplicateErrorItems ?? 0));
}

function getImportErrorToast(code: string | undefined, t: Translations): string {
    if (code === 'BACKUP_PASSPHRASE_REQUIRED') {
        return t.settings?.backupPassphraseRequired || "This backup is encrypted. Enter its passphrase and retry.";
    }
    if (code === 'BACKUP_INVALID_PASSPHRASE') {
        return t.settings?.backupInvalidPassphrase || "Incorrect backup passphrase. Please verify and retry.";
    }
    return t.settings?.importFailed || "Import failed";
}

/** 数据备份：默认导出流式 ZIP v3（可选口令加密），兼容导入 v3 ZIP 与 v1/v2 JSON */
export function DataBackupSettings({ isAdmin }: { isAdmin: boolean }) {
    const { t } = useLanguage();
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [exportPassphrase, setExportPassphrase] = useState('');
    const [importPassphrase, setImportPassphrase] = useState('');
    const [selectedFile, setSelectedFile] = useState<File | null>(null);

    const handleExport = async (all: boolean) => {
        if (all && !(await confirmDialog(t.settings?.exportAllConfirm || "Export all users' data? This may take a while."))) {
            return;
        }
        setExporting(true);
        const encrypted = exportPassphrase.length > 0;
        const fallbackName = all ? 'XueJi-backup-all.zip' : 'XueJi-backup.zip';
        try {
            if (encrypted) {
                await downloadFile('/api/export', fallbackName, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ all, passphrase: exportPassphrase }),
                });
                setExportPassphrase('');
                toast.success(t.settings?.exportSuccess || "Export successful");
            } else {
                await downloadFile(all ? '/api/export?all=true' : '/api/export', fallbackName);
                toast.success(t.settings?.exportUnencryptedSuccess || t.settings?.exportSuccess || "Export successful (unencrypted archive).");
            }
        } catch (error) {
            frontendLogger.error('[DataBackupSettings]', all ? 'Export all failed' : 'Export failed', { error });
            toast.error(t.settings?.exportFailed || "Export failed");
        } finally {
            setExporting(false);
        }
    };

    const handleImport = async (all: boolean) => {
        if (!selectedFile) return;
        const confirmText = all
            ? (t.settings?.importAllConfirm || "Import all users' data? This will restore data for all users from the export file.")
            : (t.settings?.importConfirm || "Are you sure you want to import?");
        if (!(await confirmDialog(confirmText))) return;

        setImporting(true);
        try {
            const formData = new FormData();
            formData.append('file', selectedFile);
            if (importPassphrase.length > 0) formData.append('passphrase', importPassphrase);
            const res = await fetch(all ? '/api/import?all=true' : '/api/import', { method: 'POST', body: formData });
            const payload = await res.json().catch(() => ({})) as { stats?: ImportStats; message?: string; code?: string };
            if (!res.ok || !payload.stats) {
                toast.error(getImportErrorToast(payload.code, t));
                return;
            }
            toast.success(formatImportResult(payload.stats, t));
            setSelectedFile(null);
            setImportPassphrase('');
            window.location.reload();
        } catch (error) {
            frontendLogger.error('[DataBackupSettings]', all ? 'Import all failed' : 'Import failed', { error });
            toast.error(t.settings?.importFailed || "Import failed");
        } finally {
            setImporting(false);
        }
    };

    const spinnerOr = (busy: boolean, icon: ReactNode) => (busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : icon);

    return (
        <div className="p-4 border border-blue-200 dark:border-blue-900 rounded-lg bg-blue-50 dark:bg-blue-950/40">
            <h4 className="text-sm font-bold text-blue-900 dark:text-blue-200 mb-3">
                {t.settings?.dataManagement || "Data Management"}
            </h4>

            <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-blue-800 dark:text-blue-200 font-medium">{t.settings?.exportData || "Export Data"}</span>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleExport(false)} disabled={exporting} className="bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-900/60 text-blue-900 dark:text-blue-200 border-blue-300 dark:border-blue-800">
                            {spinnerOr(exporting, <Download className="mr-2 h-4 w-4" />)}
                            {t.settings?.exportData || "Export"}
                        </Button>
                        {isAdmin && (
                            <Button variant="outline" size="sm" onClick={() => handleExport(true)} disabled={exporting} className="bg-orange-100 dark:bg-orange-900/40 hover:bg-orange-200 dark:hover:bg-orange-900/60 text-orange-900 dark:text-orange-200 border-orange-300 dark:border-orange-800">
                                {spinnerOr(exporting, <Download className="mr-2 h-4 w-4" />)}
                                {t.settings?.exportAllData || "Export All"}
                            </Button>
                        )}
                    </div>
                </div>
                <p className="text-xs text-blue-700 dark:text-blue-300">{t.settings?.exportDataDesc || "Export your learning data and images as a ZIP backup archive."}</p>
                <BackupPassphraseField
                    id="backup-export-passphrase"
                    label={t.settings?.exportPassphraseLabel || "Backup passphrase (optional)"}
                    placeholder={t.settings?.exportPassphrasePlaceholder || "Leave empty for unencrypted export, or enter a passphrase"}
                    value={exportPassphrase}
                    onChange={setExportPassphrase}
                    disabled={exporting}
                    hint={exportPassphrase ? (t.settings?.exportEncryptedHint || "Encrypted with AES-256-GCM + scrypt.") : (t.settings?.exportUnencryptedHint || "Unencrypted backups contain question images.")}
                    hintTone={exportPassphrase ? 'muted' : 'warning'}
                />
            </div>

            <div>
                <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-blue-800 dark:text-blue-200 font-medium">{t.settings?.importData || "Import Data"}</span>
                    <div className="flex items-center gap-2">
                        <input type="file" accept=".zip,.json" onChange={(e) => setSelectedFile(e.target.files?.[0] ?? selectedFile)} className="hidden" id="import-file-input" disabled={importing} />
                        <Button variant="outline" size="sm" onClick={() => document.getElementById('import-file-input')?.click()} disabled={importing} className="bg-blue-100 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-900/60 text-blue-900 dark:text-blue-200 border-blue-300 dark:border-blue-800">
                            {spinnerOr(importing, <Upload className="mr-2 h-4 w-4" />)}
                            {selectedFile?.name || t.settings?.selectFile || "Select File"}
                        </Button>
                        {selectedFile && (
                            <Button variant="outline" size="sm" onClick={() => handleImport(false)} disabled={importing} className="bg-green-100 dark:bg-green-900/40 hover:bg-green-200 dark:hover:bg-green-900/60 text-green-900 dark:text-green-200 border-green-300 dark:border-green-800">
                                {spinnerOr(importing, <CheckCircle2 className="mr-2 h-4 w-4" />)}
                                {t.settings?.importData || "Import"}
                            </Button>
                        )}
                        {selectedFile && isAdmin && (
                            <Button variant="outline" size="sm" onClick={() => handleImport(true)} disabled={importing} className="bg-orange-100 dark:bg-orange-900/40 hover:bg-orange-200 dark:hover:bg-orange-900/60 text-orange-900 dark:text-orange-200 border-orange-300 dark:border-orange-800">
                                {spinnerOr(importing, <CheckCircle2 className="mr-2 h-4 w-4" />)}
                                {t.settings?.importAllData || "Import All"}
                            </Button>
                        )}
                    </div>
                </div>
                <p className="text-xs text-blue-700 dark:text-blue-300">{t.settings?.importDataDesc || "Import from a v3 ZIP backup or legacy JSON file."}</p>
                {selectedFile && (
                    <BackupPassphraseField
                        id="backup-import-passphrase"
                        label={t.settings?.importPassphraseLabel || "Backup passphrase (if encrypted)"}
                        placeholder={t.settings?.importPassphrasePlaceholder || "Enter passphrase if encrypted"}
                        value={importPassphrase}
                        onChange={setImportPassphrase}
                        disabled={importing}
                    />
                )}
            </div>

            <DailySnapshotStatus isAdmin={isAdmin} />
        </div>
    );
}
