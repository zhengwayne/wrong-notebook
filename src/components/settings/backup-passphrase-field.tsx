"use client";

import { useState } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";

interface BackupPassphraseFieldProps {
    id: string;
    label: string;
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
    hint?: string;
    hintTone?: 'warning' | 'muted';
}

/** 备份导出/导入的可选口令输入控件（支持显隐切换） */
export function BackupPassphraseField({
    id,
    label,
    placeholder,
    value,
    onChange,
    disabled,
    hint,
    hintTone = 'muted',
}: BackupPassphraseFieldProps) {
    const [visible, setVisible] = useState(false);

    return (
        <div className="mt-2">
            <label htmlFor={id} className="block text-xs font-medium text-blue-800 dark:text-blue-200 mb-1">
                <Lock className="inline-block w-3.5 h-3.5 mr-1 align-text-bottom" />
                {label}
            </label>
            <div className="relative flex items-center">
                <input
                    id={id}
                    type={visible ? "text" : "password"}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    disabled={disabled}
                    autoComplete="off"
                    className="w-full rounded-md border border-blue-200 dark:border-blue-800 bg-white dark:bg-slate-900 px-3 py-1.5 pr-8 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
                <button
                    type="button"
                    onClick={() => setVisible((prev) => !prev)}
                    aria-label={visible ? "Hide passphrase" : "Show passphrase"}
                    disabled={disabled}
                    className="absolute right-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                    {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
            </div>
            {hint && (
                <p className={`mt-1 text-xs ${hintTone === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-blue-700 dark:text-blue-300'}`}>
                    {hint}
                </p>
            )}
        </div>
    );
}
