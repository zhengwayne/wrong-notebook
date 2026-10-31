import type { GradingVerdict, KeyQuestion, KeyQuestionInput } from "@/lib/grading";

export type { GradingVerdict, KeyQuestion, KeyQuestionInput };

import type { MatchCandidate, MatchReasonCode, PaperIdentity } from "@/lib/student-match";
import type { RosterAction, RosterDuplicate, RosterIssue, RosterPlanRow } from "@/lib/roster-import";

export type { MatchCandidate, MatchReasonCode, PaperIdentity, RosterAction };

export interface GradingStudentInfo {
    id: string;
    name: string;
    studentNo: string | null;
    /** 任务详情中返回（多个班一起收卷时区分） */
    classId?: string;
    className?: string;
}

export interface GradingClassInfo { id: string; name: string; students: GradingStudentInfo[] }

export type GradingMatchStatus = 'auto' | 'review' | 'manual';

export interface GradingMatchInfo {
    detectedName: string | null;
    detectedClass: string | null;
    detectedStudentNo: string | null;
    matchStatus: GradingMatchStatus | null;
    matchConfidence: number | null;
    matchReason: { code: MatchReasonCode; studentNoUnmatched?: boolean } | null;
    matchCandidates: MatchCandidate[];
}

export interface RosterImportPreview {
    rows: RosterPlanRow[];
    newClasses: string[];
    counts: Record<RosterAction, number>;
    errors: RosterIssue[];
    duplicates: RosterDuplicate[];
    hasHeader: boolean;
    committed?: boolean;
}

export interface IdentifyResponse {
    identity: PaperIdentity;
    match: { status: 'matched' | 'review'; studentId: string | null; confidence: number; reason: MatchReasonCode; candidates: MatchCandidate[] } | null;
    alreadySubmitted: boolean;
}

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

export interface GradingSubmissionBrief extends GradingMatchInfo {
    id: string;
    studentId: string | null;
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
    classIds: string[];
    classNames: string[];
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

export interface GradingSubmissionDetail extends GradingMatchInfo {
    id: string;
    taskId: string;
    taskTitle: string;
    studentId: string | null;
    studentName: string | null;
    status: GradingSubmissionStatus;
    totalScore: number | null;
    error: string | null;
    importedCount: number;
    images: string[];
    results: GradingResultDetail[];
}

export type { TaskSummary as GradingTaskSummaryStats } from "@/lib/grading";
