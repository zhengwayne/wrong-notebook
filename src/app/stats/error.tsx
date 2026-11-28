"use client";

import { RouteErrorFallback } from "@/components/ui/route-status";

export default function Error({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return <RouteErrorFallback error={error} reset={reset} />;
}
