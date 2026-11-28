import type { Translations } from "@/lib/translations/types";
import type { Persona } from "@/lib/personas";

export interface OnboardingStepCopy { title: string; desc: string; action: string; doneNote: string }
export interface OnboardingPersonaCopy {
    title: string;
    steps: Record<string, OnboardingStepCopy>;
    finish: { title: string; desc: string; action: string };
    toast: Record<string, { title: string; next: string; action: string }>;
}

export function personaCopy(t: Translations, persona: Persona): OnboardingPersonaCopy {
    return t.onboarding[persona] as unknown as OnboardingPersonaCopy;
}
