import { PARENT_PAPER_STATUS } from "@/lib/parent-papers";

export type ParentPaperCopy = {
    pendingRecognition: string;
    recognizing: string;
    pendingConfirmation: string;
    confirmed: string;
    failed: string;
};

export function parentPaperStatusLabel(copy: ParentPaperCopy, status: string): string {
    if (status === PARENT_PAPER_STATUS.recognizing) return copy.recognizing;
    if (status === PARENT_PAPER_STATUS.pendingConfirmation) return copy.pendingConfirmation;
    if (status === PARENT_PAPER_STATUS.confirmed) return copy.confirmed;
    if (status === PARENT_PAPER_STATUS.failed) return copy.failed;
    return copy.pendingRecognition;
}

export function parentPaperStatusClass(status: string): string {
    if (status === PARENT_PAPER_STATUS.recognizing) return "border-[#c4b5fd] bg-[#f5f3ff] text-[#6d28d9]";
    if (status === PARENT_PAPER_STATUS.pendingConfirmation) return "border-[#ddd6fe] bg-[#f5f3ff] text-foreground";
    if (status === PARENT_PAPER_STATUS.confirmed) return "border-border bg-muted/60 text-muted-foreground";
    if (status === PARENT_PAPER_STATUS.failed) return "border-destructive/40 bg-destructive/10 text-destructive";
    return "border-border bg-muted/60 text-muted-foreground";
}
