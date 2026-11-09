import { MockTestError } from './exam.errors.js';
import {
  QUESTIONS_PER_TEST,
  type QuestionStatus,
  type TopicScore,
} from './engine/index.js';

export type ChoiceLetter = 'A' | 'B' | 'C' | 'D';
const LETTERS: readonly ChoiceLetter[] = ['A', 'B', 'C', 'D'];

export function choiceLetterAt(index: number): ChoiceLetter {
  const letter = LETTERS[index];
  if (!letter) throw new MockTestError('QUESTION_NOT_FOUND');
  return letter;
}

export interface ExamChoiceDto {
  id: string;
  letter: ChoiceLetter;
  text: string;
}

/** Exam-safe question. No correctness, explanation, citation, or topic data. */
export interface ExamQuestionDto {
  attemptId: string;
  position: number;
  total: 25;
  status: QuestionStatus;
  stem: string;
  leadIn: string | null;
  choices: ExamChoiceDto[];
}

export interface ExamQuestionSource {
  position: number;
  status: QuestionStatus;
  choiceOrder: number[];
  question: {
    stem: string;
    leadIn: string | null;
    choices: { id: string; position: number; text: string }[];
  };
}

/** Maps stored MockChoice positions through the persisted display order. */
export function toExamQuestionDto(
  attemptId: string,
  source: ExamQuestionSource,
): ExamQuestionDto {
  const byStoredPosition = new Map(
    source.question.choices.map((choice) => [choice.position, choice]),
  );

  const choices = source.choiceOrder.map((storedPosition, index) => {
    const choice = byStoredPosition.get(storedPosition);
    if (!choice) throw new MockTestError('QUESTION_NOT_FOUND');
    return {
      id: choice.id,
      letter: LETTERS[index],
      text: choice.text,
    };
  });

  return {
    attemptId,
    position: source.position,
    total: 25,
    status: source.status,
    stem: source.question.stem,
    leadIn: source.question.leadIn,
    choices,
  };
}

export interface ResultSnapshotQuestion {
  position: number;
  selectedChoiceId: string | null;
  correctChoiceId: string;
  topicKey: string;
  isCorrect: boolean;
}

export interface ResultSnapshot {
  perQuestion: ResultSnapshotQuestion[];
  perTopic: TopicScore[];
}

export interface ResultDto {
  attemptId: string;
  score: number;
  total: number;
  percentage: number;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  perTopic: TopicScore[];
}

function percentage(score: number, total: number): number {
  return total === 0 ? 0 : Math.round((score / total) * 1000) / 10;
}

export function toResultDto(
  attemptId: string,
  result: { score: number; total: number; snapshot: unknown },
): ResultDto {
  const snapshot = result.snapshot as Partial<ResultSnapshot> | null;
  const questions = snapshot?.perQuestion ?? [];

  return {
    attemptId,
    score: result.score,
    total: result.total,
    percentage: percentage(result.score, result.total),
    correctCount: questions.filter((question) => question.isCorrect).length,
    incorrectCount: questions.filter(
      (question) => question.selectedChoiceId !== null && !question.isCorrect,
    ).length,
    unansweredCount: questions.filter(
      (question) => question.selectedChoiceId === null,
    ).length,
    perTopic: snapshot?.perTopic ?? [],
  };
}

export interface ReviewCitationDto {
  documentTitleSnapshot: string;
  pageNumber: number;
  quote: string;
}

export interface ReviewChoiceDto extends ExamChoiceDto {
  isCorrect: boolean;
  explanation: string;
}

export interface ReviewQuestionDto {
  position: number;
  status: QuestionStatus;
  stem: string;
  leadIn: string | null;
  choices: ReviewChoiceDto[];
  selectedChoiceId: string | null;
  correctChoiceId: string;
  isCorrect: boolean;
  underReview: boolean;
  topicName: string;
  citations: ReviewCitationDto[];
}

export interface ReviewDto {
  attemptId: string;
  score: number;
  total: number;
  percentage: number;
  perTopic: TopicScore[];
  questions: ReviewQuestionDto[];
}

export function toReviewDto(
  attemptId: string,
  result: { score: number; total: number; snapshot: unknown },
  questions: ReviewQuestionDto[],
): ReviewDto {
  const snapshot = result.snapshot as Partial<ResultSnapshot> | null;

  return {
    attemptId,
    score: result.score,
    total: result.total,
    percentage: percentage(result.score, result.total),
    perTopic: snapshot?.perTopic ?? [],
    questions,
  };
}

export { QUESTIONS_PER_TEST };
