import { redirect } from "next/navigation";

/** 小程序「在电脑上做」只能带纯路径：这里转到任务的「答卷」页签 */
export default async function GradingTaskPapersRedirect({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    redirect(`/grading/${encodeURIComponent(id)}?tab=papers`);
}
