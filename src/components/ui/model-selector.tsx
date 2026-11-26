"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, ChevronDown, ExternalLink, RefreshCw, Loader2 } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { getApiErrorMessage } from "@/lib/error-message";
import { AIModel, ModelsResponse } from "@/types/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { isVendorProvider, VENDOR_PRESETS } from "@/lib/ai/vendor-presets";
import type { VendorProviderId } from "@/lib/ai/vendor-presets";
import type { AiModelRole } from "@/lib/ai/roles";
import { frontendLogger } from "@/lib/frontend-logger";
import { toast } from "@/lib/feedback";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
    provider: 'openai' | 'gemini' | 'anthropic' | VendorProviderId;
    apiKey?: string;
    baseUrl?: string;
    currentModel?: string;
    role?: AiModelRole;
    instanceId?: string;
    onModelChange: (model: string) => void;
    /** 官方的模型列表文档，显示在字段名旁 */
    docsHref?: string;
}

/** 按输入过滤模型：忽略大小写，名称或提供方包含即可 */
export function filterModels(models: AIModel[], query: string): AIModel[] {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q) || (model.owned_by || '').toLowerCase().includes(q));
}

/**
 * 模型名称：可直接输入，也可点刷新从当前渠道的 {Base URL}/models 拉取列表后搜索选择。
 * 列表由服务端用已保存的 API Key 请求（浏览器只传掩码），失败时弹出提示并保留手动输入。
 */
export function ModelSelector({ provider, apiKey, baseUrl, currentModel, role, instanceId, onModelChange, docsHref }: ModelSelectorProps) {
    const { t } = useLanguage();
    const copy = t.modelSelector;
    const [models, setModels] = useState<AIModel[]>([]);
    const [loading, setLoading] = useState(false);
    const [value, setValue] = useState(currentModel || '');
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState<string | null>(null);
    const [active, setActive] = useState(0);
    const boxRef = useRef<HTMLDivElement>(null);
    const listId = `model-list-${role || 'vision'}-${instanceId || provider}`;

    // 当外部 currentModel 变化时同步（用于实例切换），在渲染时比较
    const [prevCurrentModel, setPrevCurrentModel] = useState(currentModel);
    if (currentModel !== prevCurrentModel) {
        setPrevCurrentModel(currentModel);
        setValue(currentModel || '');
    }

    // 切换渠道或实例后，旧的列表不再适用
    const scopeKey = `${provider}|${instanceId || ''}|${role || ''}`;
    const [prevScope, setPrevScope] = useState(scopeKey);
    if (scopeKey !== prevScope) {
        setPrevScope(scopeKey);
        setModels([]);
        setOpen(false);
    }

    const filtered = useMemo(() => filterModels(models, query ?? ''), [models, query]);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    const describeError = (message: string | undefined) => {
        if (message === 'BASE_URL_CHANGED') return copy.baseUrlChanged;
        if (message === 'API key is required') return copy.apiKeyRequired;
        return `${copy.fetchFailed}${message ? `：${message}` : ''}`;
    };

    const fetchModels = async () => {
        if (!apiKey) {
            toast.error(copy.enterApiKeyFirst);
            return;
        }
        setLoading(true);
        try {
            const data = await apiClient.post<ModelsResponse>("/api/ai/models", {
                provider,
                apiKey,
                ...(baseUrl && { baseUrl }),
                ...(role && { role }),
                ...(instanceId && { instanceId }),
            });
            if ('error' in data && typeof data.error === 'string') {
                setModels([]);
                toast.error(describeError(data.error));
                return;
            }
            const sorted = [...data.models].sort((a, b) => a.id.localeCompare(b.id));
            setModels(sorted);
            if (sorted.length === 0) {
                toast.error(copy.noVisionModel);
                return;
            }
            toast.success(copy.loaded.replace('{count}', String(sorted.length)));
            setQuery('');
            setActive(0);
            setOpen(true);
        } catch (err) {
            frontendLogger.error('[ModelSelector]', 'Failed to fetch models', { error: err });
            toast.error(describeError(getApiErrorMessage(err) ?? (err instanceof Error ? err.message : undefined)));
        } finally {
            setLoading(false);
        }
    };

    const choose = (modelId: string) => {
        setValue(modelId);
        onModelChange(modelId);
        setQuery(null);
        setOpen(false);
    };

    const onInput = (next: string) => {
        setValue(next);
        onModelChange(next);
        setQuery(next);
        setActive(0);
        if (models.length > 0) setOpen(true);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (!open || filtered.length === 0) {
            if (event.key === 'ArrowDown' && models.length > 0) {
                setOpen(true);
                event.preventDefault();
            }
            return;
        }
        if (event.key === 'ArrowDown') {
            setActive((index) => Math.min(index + 1, filtered.length - 1));
            event.preventDefault();
        } else if (event.key === 'ArrowUp') {
            setActive((index) => Math.max(index - 1, 0));
            event.preventDefault();
        } else if (event.key === 'Enter') {
            choose(filtered[Math.min(active, filtered.length - 1)].id);
            event.preventDefault();
        } else if (event.key === 'Escape') {
            setOpen(false);
            event.preventDefault();
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Label className="flex-1">{copy.modelName}</Label>
                {docsHref && (
                    <a href={docsHref} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline">
                        {t.settings.ai.docLinks.models}
                        <ExternalLink className="h-3 w-3" />
                    </a>
                )}
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={fetchModels}
                    disabled={loading || !apiKey}
                    aria-label={copy.selectFromList}
                    title={copy.selectFromList}
                    data-testid="model-refresh"
                >
                    {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                </Button>
            </div>

            <div ref={boxRef} className="relative">
                <Input
                    value={value}
                    onChange={(e) => onInput(e.target.value)}
                    onFocus={() => { if (models.length > 0) setOpen(true); }}
                    onKeyDown={onKeyDown}
                    placeholder={isVendorProvider(provider) ? VENDOR_PRESETS[provider].model : provider === 'openai' ? "gpt-6.1-sol" : copy.searchPlaceholder}
                    role="combobox"
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    className={models.length > 0 ? "pr-9" : undefined}
                    data-testid="model-input"
                />
                {models.length > 0 && (
                    <button
                        type="button"
                        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                        onClick={() => { setQuery(''); setOpen((current) => !current); }}
                        aria-label={copy.showList}
                        title={copy.showList}
                    >
                        <ChevronDown className="h-4 w-4" />
                    </button>
                )}
                {open && models.length > 0 && (
                    <ul
                        id={listId}
                        role="listbox"
                        className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
                        data-testid="model-list"
                    >
                        {filtered.length === 0 ? (
                            <li className="px-2 py-1.5 text-xs text-muted-foreground">{copy.noMatch}</li>
                        ) : filtered.map((model, index) => (
                            <li
                                key={model.id}
                                role="option"
                                aria-selected={model.id === value}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5",
                                    index === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                                )}
                                onMouseDown={(event) => { event.preventDefault(); choose(model.id); }}
                                onMouseEnter={() => setActive(index)}
                            >
                                <Check className={cn("h-3.5 w-3.5 shrink-0", model.id === value ? "opacity-100" : "opacity-0")} />
                                <span className="truncate">{model.name}</span>
                                {model.owned_by && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{model.owned_by}</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
