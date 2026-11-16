"use client";

import type { Dispatch, SetStateAction } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AiConnectionTest } from "@/components/settings/ai-connection-test";
import { AnthropicSettings } from "@/components/settings/anthropic-settings";
import { AzureSettings } from "@/components/settings/azure-settings";
import { GeminiSettings } from "@/components/settings/gemini-settings";
import { MiniMaxCodeSettings } from "@/components/settings/minimax-code-settings";
import { OpenAIInstanceSettings } from "@/components/settings/openai-instance-settings";
import { ProviderDocLinks } from "@/components/settings/provider-doc-links";
import { VendorSettings } from "@/components/settings/vendor-settings";
import { useLanguage } from "@/contexts/LanguageContext";
import { applyTextRoleConfig, getConfigForRole, isTextSameAsVision, snapshotVisionAsTextAi } from "@/lib/ai/roles";
import { getVendorName, isVendorProvider, VENDOR_PROVIDER_IDS } from "@/lib/ai/vendor-presets";
import type { AppConfig } from "@/types/api";

interface AiProviderSettingsProps {
    config: AppConfig;
    setConfig: Dispatch<SetStateAction<AppConfig>>;
    loading: boolean;
    saving: boolean;
    onSave: () => void;
}

interface ProviderFieldsProps {
    config: AppConfig;
    onChange: (next: AppConfig) => void;
}

/** 单个渠道的提供商选择与凭据表单 */
function ProviderFields({ config, onChange }: ProviderFieldsProps) {
    const { t, language } = useLanguage();
    const setProvider = (val: AppConfig["aiProvider"]) => onChange({ ...config, aiProvider: val });

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Label>{t.settings?.tabs?.ai || "AI Provider"}</Label>
                <Select value={config.aiProvider} onValueChange={setProvider}>
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="minimax">{getVendorName("minimax", language)}</SelectItem>
                        <SelectItem value="minimax-code">MiniMax Code OAuth</SelectItem>
                        {VENDOR_PROVIDER_IDS.filter((id) => id !== "minimax").map((id) => (
                            <SelectItem key={id} value={id}>{getVendorName(id, language)}</SelectItem>
                        ))}
                        <SelectItem value="anthropic">Anthropic / Compatible</SelectItem>
                        <SelectItem value="azure">Azure OpenAI</SelectItem>
                        <SelectItem value="openai">OpenAI / Compatible</SelectItem>
                        <SelectItem value="gemini">Google Gemini</SelectItem>
                    </SelectContent>
                </Select>
                <ProviderDocLinks provider={config.aiProvider} />
            </div>

            {config.aiProvider === "openai" && (
                <OpenAIInstanceSettings value={config.openai} onChange={(openai) => onChange({ ...config, openai })} />
            )}
            {config.aiProvider === "gemini" && (
                <GeminiSettings value={config.gemini} onChange={(gemini) => onChange({ ...config, gemini })} />
            )}
            {config.aiProvider === "minimax-code" && (
                <MiniMaxCodeSettings value={config.minimaxCode} onChange={(minimaxCode) => onChange({ ...config, minimaxCode })} />
            )}
            {config.aiProvider === "anthropic" && (
                <AnthropicSettings value={config.anthropic} onChange={(anthropic) => onChange({ ...config, anthropic })} />
            )}
            {isVendorProvider(config.aiProvider) && (
                <VendorSettings
                    key={config.aiProvider}
                    provider={config.aiProvider}
                    value={config[config.aiProvider]}
                    onChange={(vendorConfig) => onChange({ ...config, [config.aiProvider]: vendorConfig })}
                />
            )}
            {config.aiProvider === "azure" && (
                <AzureSettings value={config.azure} onChange={(azure) => onChange({ ...config, azure })} />
            )}
        </div>
    );
}

/** AI 渠道设置：多模态与文本对话可分开配置，默认复用以免打断已有用户 */
export function AiProviderSettings({ config, setConfig, loading, saving, onSave }: AiProviderSettingsProps) {
    const { t } = useLanguage();
    const shared = isTextSameAsVision(config);
    const textView = getConfigForRole(config, "text");

    if (loading) {
        return (
            <div className="flex justify-center py-4">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    const saveButton = (
        <Button onClick={onSave} disabled={saving} className="flex-1">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t.settings?.ai?.save || "Save AI Settings"}
        </Button>
    );

    return (
        <div className="space-y-4">
            <section className="space-y-4 rounded-lg border bg-muted/30 p-4">
                <div className="space-y-1">
                    <h3 className="text-sm font-semibold">{t.settings?.ai?.visionRole || "Multimodal model"}</h3>
                    <p className="text-xs text-muted-foreground">{t.settings?.ai?.visionRoleDesc}</p>
                </div>
                <ProviderFields config={getConfigForRole(config, "vision")} onChange={setConfig} />
                <AiConnectionTest
                    config={getConfigForRole(config, "vision")}
                    saving={saving}
                    testLabel={t.settings?.ai?.testVision}
                    saveButton={null}
                />
            </section>

            <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-4">
                <Switch
                    id="text-same-as-vision"
                    checked={shared}
                    onCheckedChange={(checked) => {
                        if (checked) {
                            setConfig((prev) => ({ ...prev, textSameAsVision: true }));
                            return;
                        }
                        setConfig((prev) => ({
                            ...prev,
                            textSameAsVision: false,
                            aiTextProvider: prev.aiTextProvider ?? prev.aiProvider,
                            textAi: prev.textAi ?? snapshotVisionAsTextAi(prev),
                        }));
                    }}
                />
                <div className="space-y-1">
                    <Label htmlFor="text-same-as-vision" className="text-sm font-medium leading-none">
                        {t.settings?.ai?.sameAsVision}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t.settings?.ai?.sameAsVisionHint}</p>
                </div>
            </div>

            {!shared && (
                <section className="space-y-4 rounded-lg border bg-muted/30 p-4">
                    <div className="space-y-1">
                        <h3 className="text-sm font-semibold">{t.settings?.ai?.textRole || "Text chat model"}</h3>
                        <p className="text-xs text-muted-foreground">{t.settings?.ai?.textRoleDesc}</p>
                    </div>
                    <ProviderFields
                        config={textView}
                        onChange={(view) => setConfig((prev) => applyTextRoleConfig(prev, view))}
                    />
                    <AiConnectionTest
                        config={textView}
                        saving={saving}
                        testLabel={t.settings?.ai?.testText}
                        saveButton={null}
                    />
                </section>
            )}

            {saveButton}
        </div>
    );
}
