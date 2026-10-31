import { cn } from "@/lib/utils";

interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
    className?: string;
}

/** 原生下拉框：移动端调用系统选择器，适合快速选学生 */
export function NativeSelect({ className, children, ...props }: NativeSelectProps) {
    return (
        <select
            {...props}
            className={cn("h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50", className)}
        >
            {children}
        </select>
    );
}
