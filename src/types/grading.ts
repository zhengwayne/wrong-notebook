import type { GradingVerdict, KeyQuestion, KeyQuestionInput } from "@/lib/grading";

export type { GradingVerdict, KeyQuestion, KeyQuestionInput };

export interface GradingStudentInfo { id: string; name: string }

export interface GradingClassInfo { id: string; name: string; students: GradingStudentInfo[] }

export type GradingSubmissionStatus = 'pending' | 'grading' | 'graded' | 'failed' | 'confirmed';

export interface GradingTaskSummary {
    id: string;
    title: string;
    subjectName: string;
    className: string;
    studentCount: number;
    questionCount: number;
    submissionCount: number;
    confirmedCount: number;
    createdAt: string;
}

export interface GradingSubmissionBrief {
    id: string;
    studentId: string | null;
    detectedName: string | null;
    status: GradingSubmissionStatus;
    totalScore: number | null;
    error: string | null;
    importedCount: number;
    pageCount: number;
    createdAt: string;
}

export interface GradingTaskDetail {
    id: string;
    title: string;
    subjectName: string;
    classId: string;
    className: string;
    students: GradingStudentInfo[];
    questions: KeyQuestion[];
    submissions: GradingSubmissionBrief[];
}

export interface GradingResultDetail {
    id: string;
    keyQuestionId: string;
    studentAnswer: string | null;
    verdict: GradingVerdict;
    score: number;
    aiScore: number | null;
    reason: string | null;
    source: 'auto' | 'ai' | 'teacher';
    errorItemId: string | null;
    question: KeyQuestion;
}

export interface GradingSubmissionDetail {
    id: string;
    taskId: string;
    taskTitle: string;
    studentId: string | null;
    studentName: string | null;
    detectedName: string | null;
    status: GradingSubmissionStatus;
    totalScore: number | null;
    error: string | null;
    importedCount: number;
    images: string[];
    results: GradingResultDetail[];
}

export type { TaskSummary as GradingTaskSummaryStats } from "@/lib/grading";
