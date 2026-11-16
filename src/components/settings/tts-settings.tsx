"use client";

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { FieldLabel } from "@/components/settings/field-label";
import { ProviderErrorDetail } from "@/components/settings/provider-error-detail";
import { useLanguage } from "@/contexts/LanguageContext";
import { getVendorName } from "@/lib/ai/vendor-presets";
import { getApiErrorDetails, getApiErrorMessage } from "@/lib/error-message";
import { toast } from "@/lib/feedback";
import { frontendLogger } from "@/lib/frontend-logger";
import { speakText, stopSpeaking } from "@/lib/speak-text";
import { CLOUD_TTS_DEFAULTS, CLOUD_TTS_DOCS, CLOUD_TTS_FREE_TRIAL, DEFAULT_EDGE_ENGLISH_VOICE, DEFAULT_EDGE_VOICE, DEFAULT_TTS_RATE, EDGE_EN_VOICES, EDGE_ZH_VOICES, MAX_TTS_RATE, MIN_TTS_RATE, TTS_MODES, clampTtsRate, defaultTtsEndpoint, getTtsChannelConfig, hasOwnTtsApiKey, isCloudTtsProvider } from "@/lib/tts/constants";
import type { CloudTtsSettings, TtsMode } from "@/lib/tts/constants";
import type { AppConfig } from "@/types/api";

interface TtsSettingsProps {
    config: AppConfig;
    setConfig: Dispatch<SetStateAction<AppConfig>>;
    saving: boolean;
    onSave: () => Promise<void>;
}

function voiceLabel(voices: Record<string, string>, id: string): string {
    return voices[id] || id;
}

/**
 * 语音讲解的朗读方式（管理员）：默认 Edge 在线语音（晓晓），也可改用浏览器本地语音或付费云端渠道。
 * 付费云端语音的 API Key 与「AI 设置」中对应渠道共用。
 */
export function TtsSettings({ config, setConfig, saving, onSave }: TtsSettingsProps) {
    const { t, language } = useLanguage();
    const texts = t.settings.tts;
    const [previewing, setPreviewing] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);
    const mode: TtsMode = config.tts?.mode ?? "edge";
    const provider = isCloudTtsProvider(mode) ? mode : null;
    const paidProvider = provider && provider !== "edge" ? provider : null;
    const settings = provider ? config.tts?.[provider] : undefined;
    const rate = clampTtsRate(config.tts?.rate, DEFAULT_TTS_RATE);

    const updateSettings = (key: keyof CloudTtsSettings, value: string) => {
        if (!provider) return;
        setConfig((prev) => ({ ...prev, tts: { ...prev.tts, [provider]: { ...prev.tts?.[provider], [key]: value } } }));
    };
    const updateRate = (value: number) => {
        setConfig((prev) => ({ ...prev, tts: { ...prev.tts, rate: clampTtsRate(value) } }));
    };
    const ownApiKey = paidProvider ? hasOwnTtsApiKey(paidProvider) : false;
    const channel = paidProvider ? getTtsChannelConfig(config, paidProvider) : undefined;
    const apiKey = paidProvider ? (ownApiKey ? settings?.apiKey : channel?.apiKey) : undefined;
    const updateApiKey = (value: string) => {
        if (!paidProvider) return;
        if (ownApiKey) updateSettings("apiKey", value);
        else setConfig((prev) => ({ ...prev, [paidProvider]: { ...prev[paidProvider], apiKey: value } }));
    };

    const hint = mode === "edge" ? texts.edgeHint : provider ? texts.cloudHint : texts.browserHint;

    const preview = async () => {
        stopSpeaking();
        setPreviewing(true);
        setPreviewError(null);
        try {
            await onSave();
            const previewLanguage = language === "en" ? "en" : "zh";
            const handle = await speakText(texts.previewText, { language: previewLanguage, rate });
            await handle.done;
        } catch (error) {
            frontendLogger.error("[TtsSettings]", "Preview failed", { error });
            const code = getApiErrorMessage(error);
            const message = mode === "edge" || mode === "browser"
                ? texts.previewFailedNetwork
                : code === "TTS_NOT_CONFIGURED" ? texts.notConfigured : code === "TTS_PROVIDER_ERROR" ? texts.providerError : texts.previewFailed;
            toast.error(message);
            setPreviewError(getApiErrorDetails(error) ?? null);
        } finally {
            setPreviewing(false);
        }
    };

    return (
        <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
            <div className="space-y-2">
                <Label>{texts.title}</Label>
                <Select
                    value={mode}
                    onValueChange={(value: TtsMode) => setConfig((prev) => ({ ...prev, tts: { ...prev.tts, mode: value } }))}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TTS_MODES.map((value) => (
                            <SelectItem key={value} value={value}>{texts.modes[value]}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>

            <div className="space-y-2">
                <Label htmlFor="tts-rate">{texts.rate}（{rate.toFixed(2)}×）</Label>
                <Slider
                    id="tts-rate"
                    min={MIN_TTS_RATE}
                    max={MAX_TTS_RATE}
                    step={0.05}
                    value={[rate]}
                    onValueChange={([value]) => updateRate(value)}
                    className="w-full"
                />
                <p className="text-xs text-muted-foreground">{texts.rateHint}</p>
            </div>

            {mode === "edge" && (
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                        <FieldLabel label={texts.voice} href={CLOUD_TTS_DOCS.edge.voice} linkText={texts.voiceList} />
                        <Select
                            value={settings?.voice || DEFAULT_EDGE_VOICE}
                            onValueChange={(value) => updateSettings("voice", value)}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {EDGE_ZH_VOICES.map((id) => (
                                    <SelectItem key={id} value={id}>{voiceLabel(texts.voices, id)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-2">
                        <FieldLabel label={texts.englishVoice} href={CLOUD_TTS_DOCS.edge.voice} linkText={texts.voiceList} />
                        <Select
                            value={settings?.englishVoice || DEFAULT_EDGE_ENGLISH_VOICE}
                            onValueChange={(value) => updateSettings("englishVoice", value)}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {EDGE_EN_VOICES.map((id) => (
                                    <SelectItem key={id} value={id}>{voiceLabel(texts.voices, id)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground sm:col-span-2">{texts.englishVoiceHint}</p>
                    </div>
                </div>
            )}

            {paidProvider && (
                <div key={paidProvider} className="space-y-3">
                    {CLOUD_TTS_FREE_TRIAL[paidProvider] && (
                        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
                            {texts.freeTrial}{" "}
                            <a href={CLOUD_TTS_FREE_TRIAL[paidProvider]} target="_blank" rel="noopener noreferrer" className="underline">{texts.freeTrialLink}</a>
                        </div>
                    )}
                    <div className="space-y-2">
                        <FieldLabel label={paidProvider === "openai" ? "OpenAI API Key" : ownApiKey ? texts.speechApiKey : `${getVendorName(paidProvider, language)} API Key`} href={CLOUD_TTS_DOCS[paidProvider].apiKey} linkText={t.settings.ai.docLinks.apiKey} />
                        <PasswordInput
                            value={apiKey || ""}
                            onChange={(e) => updateApiKey(e.target.value)}
                            placeholder={paidProvider === "qwen" ? "sk-sp-..." : ownApiKey ? "" : "sk-..."}
                        />
                        <p className="text-xs text-muted-foreground">{texts.apiKeyHint[paidProvider]}</p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <FieldLabel label={texts.model} href={CLOUD_TTS_DOCS[paidProvider].model} linkText={texts.docs} />
                            <Input
                                value={settings?.model || ""}
                                onChange={(e) => updateSettings("model", e.target.value)}
                                placeholder={CLOUD_TTS_DEFAULTS[paidProvider].model}
                            />
                        </div>
                        <div className="space-y-2">
                            <FieldLabel label={texts.voice} href={CLOUD_TTS_DOCS[paidProvider].voice} linkText={texts.voiceList} />
                            <Input
                                value={settings?.voice || ""}
                                onChange={(e) => updateSettings("voice", e.target.value)}
                                placeholder={CLOUD_TTS_DEFAULTS[paidProvider].voice}
                            />
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{texts.voiceHint[paidProvider]}</p>
                    <div className="space-y-2">
                        <FieldLabel label={texts.endpoint} href={CLOUD_TTS_DOCS[paidProvider].endpoint} linkText={texts.docs} />
                        <Input
                            value={settings?.endpoint || ""}
                            onChange={(e) => updateSettings("endpoint", e.target.value)}
                            placeholder={defaultTtsEndpoint(paidProvider, channel)}
                        />
                        <p className="text-xs text-muted-foreground">{texts.endpointHint}</p>
                    </div>
                </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" onClick={() => void preview()} disabled={saving || previewing} className="sm:w-auto">
                    {previewing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                    {texts.preview}
                </Button>
                <Button onClick={() => void onSave()} disabled={saving || previewing} className="flex-1">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {texts.save}
                </Button>
            </div>
            {previewError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-2 dark:border-red-900 dark:bg-red-950/40">
                    <ProviderErrorDetail detail={previewError} />
                </div>
            )}
        </div>
    );
}
