import { QUESTIONS_PER_TEST } from './types.js';

export interface GradeItem {
  position: number;
  topicKey: string;
  selectedChoiceId: string | null;
  correctChoiceId: string;
}

export interface TopicScore {
  topicKey: string;
  correct: number;
  total: number;
}

export interface QuestionScore {
  position: number;
  selectedChoiceId: string | null;
  correctChoiceId: string;
  isCorrect: boolean;
}

export interface GradeResult {
  score: number;
  total: number;
  /** Percentage rounded to one decimal place. */
  percentage: number;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  perTopic: TopicScore[];
  perQuestion: QuestionScore[];
}

function assertItems(items: readonly GradeItem[]): void {
  if (items.length !== QUESTIONS_PER_TEST) {
    throw new Error('Invalid grading items.');
  }

  const seen = new Set<number>();
  for (const item of items) {
    if (
      !Number.isInteger(item.position) ||
      item.position < 1 ||
      item.position > QUESTIONS_PER_TEST ||
      seen.has(item.position)
    ) {
      throw new Error('Invalid grading items.');
    }
    seen.add(item.position);
  }
}

/**
 * Server-side grading. Unanswered is incorrect; there is no pass/fail.
 * Items may arrive unsorted; output is sorted by position and topicKey.
 */
export function gradeAttempt(items: readonly GradeItem[]): GradeResult {
  assertItems(items);
  const total = items.length;

  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;
  const topics = new Map<string, TopicScore>();

  const perQuestion = [...items]
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      const isCorrect =
        item.selectedChoiceId !== null &&
        item.selectedChoiceId === item.correctChoiceId;

      if (item.selectedChoiceId === null) unansweredCount += 1;
      else if (isCorrect) correctCount += 1;
      else incorrectCount += 1;

      const topic = topics.get(item.topicKey) ?? {
        topicKey: item.topicKey,
        correct: 0,
        total: 0,
      };
      topic.total += 1;
      if (isCorrect) topic.correct += 1;
      topics.set(item.topicKey, topic);

      return {
        position: item.position,
        selectedChoiceId: item.selectedChoiceId,
        correctChoiceId: item.correctChoiceId,
        isCorrect,
      };
    });

  // Unanswered counts as incorrect, so score is the correct count only.
  const score = correctCount;
  const percentage = Math.round((score / total) * 1000) / 10;

  const perTopic = [...topics.values()].sort((a, b) =>
    a.topicKey < b.topicKey ? -1 : a.topicKey > b.topicKey ? 1 : 0,
  );

  return {
    score,
    total,
    percentage,
    correctCount,
    incorrectCount,
    unansweredCount,
    perTopic,
    perQuestion,
  };
}
