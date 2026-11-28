import { describe, expect, it } from 'vitest';
import {
  countVerdicts,
  defaultPaperTitle,
  pollOutcome,
  setGradeDraft,
  subjectKeyFromNotebookName,
  takeGradeDraft,
  VERDICTS,
  verdictPatch,
  willImport,
} from '../src/utils/paper';
import { LOW_CONFIDENCE } from '../src/utils/paper';
import { LOW_CONFIDENCE_THRESHOLD, PARENT_REVIEW_VERDICTS, effectiveVerdict, shouldImportVerdict } from '../../src/lib/parent-paper-review';
import { PARENT_PAPER_STATUS } from '../../src/lib/parent-papers';

describe('mini program whole-page grading (same model as web ParentPaper)', () => {
  it('mirrors the web verdicts, threshold and statuses', () => {
    expect([...VERDICTS].sort()).toEqual([...PARENT_REVIEW_VERDICTS].sort());
    expect(LOW_CONFIDENCE).toBe(LOW_CONFIDENCE_THRESHOLD);
    expect(pollOutcome(PARENT_PAPER_STATUS.pendingConfirmation)).toBe('ready');
    expect(pollOutcome(PARENT_PAPER_STATUS.recognizing)).toBe('waiting');
    expect(pollOutcome(PARENT_PAPER_STATUS.pendingRecognition)).toBe('waiting');
    expect(pollOutcome(PARENT_PAPER_STATUS.failed)).toBe('failed');
    expect(pollOutcome(PARENT_PAPER_STATUS.confirmed)).toBe('confirmed');
  });

  it('wrong and partial go to the notebook, correct stays on the paper', () => {
    for (const verdict of VERDICTS) {
      const patch = verdictPatch(verdict);
      expect(patch.overrideVerdict).toBe(verdict);
      expect(patch.selected).toBe(shouldImportVerdict(effectiveVerdict(verdict)));
      expect(willImport({ effectiveVerdict: verdict, selected: patch.selected, importedErrorItemId: null })).toBe(verdict !== 'correct');
    }
    expect(willImport({ effectiveVerdict: 'wrong', selected: true, importedErrorItemId: 'e1' })).toBe(false);
    expect(countVerdicts([{ effectiveVerdict: 'correct' }, { effectiveVerdict: 'wrong' }, { effectiveVerdict: 'partial' }, { effectiveVerdict: 'wrong' }]))
      .toEqual({ correct: 1, partial: 1, wrong: 2 });
  });

  it('derives subject key and title, and hands photos over once', () => {
    expect(subjectKeyFromNotebookName('初中物理')).toBe('physics');
    expect(subjectKeyFromNotebookName('数学')).toBe('math');
    expect(subjectKeyFromNotebookName('自动按学科归类')).toBeUndefined();
    expect(subjectKeyFromNotebookName('')).toBeUndefined();
    expect(defaultPaperTitle('小雨', new Date(2026, 10, 26))).toBe('小雨 11月26日');
    setGradeDraft({ learnerId: 'c1', learnerName: '小雨', photos: [{ path: 'a', size: 1 }] });
    expect(takeGradeDraft()?.learnerId).toBe('c1');
    expect(takeGradeDraft()).toBeNull();
  });
});
