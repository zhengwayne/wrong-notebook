import { CalendarCheck, Camera, CheckCheck, ClipboardList, Layers, ListChecks, UserPlus, Users, type LucideIcon } from "lucide-react";
import type { Persona } from "@/lib/personas";

const ICONS: Record<Persona, Record<string, LucideIcon>> = {
    teacher: { class: Users, task: ClipboardList, collect: Camera, confirm: CheckCheck },
    parent: { child: UserPlus, paper: Camera, confirm: ListChecks, review: CalendarCheck },
    self: { capture: Camera, collect: Layers, review: CalendarCheck },
};

export function stepIcon(persona: Persona, key: string): LucideIcon {
    return ICONS[persona][key] ?? ListChecks;
}
