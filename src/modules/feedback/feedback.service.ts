import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma.js';
import {
  FEEDBACK_QUESTIONS,
  FEEDBACK_SECTIONS,
  FEEDBACK_STEPS,
  RATING_LABELS,
  RATING_QUESTION_IDS,
  interestLevelFor,
  type FeedbackQuestion,
} from './feedback.questions.js';

/** Thrown on bad public submissions → controller maps to 400. */
export class FeedbackValidationError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT = 300;
const MAX_LONG = 2000;

export type FeedbackAnswers = Record<string, unknown>;

function clean(s: unknown, max: number): string {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '') // strip control chars
    .trim()
    .slice(0, max);
}

export const feedbackService = {
  /** Public: questions + section/step layout + SAM dropdown options. */
  async getForm() {
    const sams = await prisma.user.findMany({
      where: { role: 'SAM' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return {
      sections: FEEDBACK_SECTIONS,
      steps: FEEDBACK_STEPS,
      questions: FEEDBACK_QUESTIONS,
      ratingLabels: RATING_LABELS,
      sams,
    };
  },

  /**
   * Public: validate, score, and store a submission. Returns a minimal
   * confirmation (only the new feedback id + derived score).
   */
  async submit(rawAnswers: FeedbackAnswers) {
    if (!rawAnswers || typeof rawAnswers !== 'object') {
      throw new FeedbackValidationError('Malformed submission.');
    }

    const answers: FeedbackAnswers = {};

    for (const q of FEEDBACK_QUESTIONS) {
      // Conditional questions that shouldn't show are simply skipped.
      if (q.showIf && !conditionMet(q, rawAnswers)) continue;

      const raw = rawAnswers[q.id];
      const present =
        raw !== undefined &&
        raw !== null &&
        raw !== '' &&
        !(Array.isArray(raw) && raw.length === 0);

      if (!present) {
        if (q.required) throw new FeedbackValidationError(`${q.label} is required.`);
        continue;
      }

      answers[q.id] = validateAnswer(q, raw);
    }

    // Resolve + verify the SAM.
    const samId = answers.yourSam as string;
    const sam = await prisma.user.findFirst({
      where: { id: samId, role: 'SAM' },
      select: { id: true },
    });
    if (!sam) throw new FeedbackValidationError('Please choose a valid SAM from the list.');

    // Score = mean of answered 1–5 ratings.
    const ratings = RATING_QUESTION_IDS.map((id) => answers[id]).filter(
      (v): v is number => typeof v === 'number',
    );
    const overallScore =
      ratings.length > 0
        ? Math.round((ratings.reduce((s, v) => s + v, 0) / ratings.length) * 100) / 100
        : null;
    const interestLevel = overallScore === null ? null : interestLevelFor(overallScore);
    const npsScore = typeof answers.q10 === 'number' ? answers.q10 : null;

    const created = await prisma.feedback.create({
      data: {
        companyName: clean(answers.q1, MAX_TEXT) || 'Unknown',
        customerName: clean(answers.q2, MAX_TEXT) || 'Unknown',
        samId,
        responses: answers as Prisma.InputJsonValue,
        overallScore,
        interestLevel,
        npsScore,
      },
      select: { id: true },
    });

    return { id: created.id, overallScore, interestLevel };
  },

  /**
   * Admin list. ADMIN / SUPER_ADMIN_2 see all; SAM_HEAD sees only feedback for
   * SAMs reporting to them.
   */
  async list(opts: { requester: { id: string; role: string } }) {
    let samFilter: Prisma.FeedbackWhereInput = {};
    if (opts.requester.role === 'SAM_HEAD') {
      const reports = await prisma.user.findMany({
        where: { role: 'SAM', samHeadId: opts.requester.id },
        select: { id: true },
      });
      samFilter = { samId: { in: reports.map((r) => r.id) } };
    }
    return prisma.feedback.findMany({
      where: samFilter,
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true,
        customerName: true,
        companyName: true,
        overallScore: true,
        interestLevel: true,
        npsScore: true,
        submittedAt: true,
        sam: { select: { id: true, name: true } },
      },
    });
  },

  /** Admin detail — full answers + the question catalog to render labels. */
  async getById(id: string, opts: { requester: { id: string; role: string } }) {
    const fb = await prisma.feedback.findUnique({
      where: { id },
      include: { sam: { select: { id: true, name: true, email: true } } },
    });
    if (!fb) return null;

    if (opts.requester.role === 'SAM_HEAD') {
      const owner = await prisma.user.findFirst({
        where: { id: fb.samId, samHeadId: opts.requester.id },
        select: { id: true },
      });
      if (!owner) return null; // not in their team → treat as not found
    }

    return {
      id: fb.id,
      customerName: fb.customerName,
      companyName: fb.companyName,
      sam: fb.sam,
      responses: fb.responses,
      overallScore: fb.overallScore,
      interestLevel: fb.interestLevel,
      npsScore: fb.npsScore,
      submittedAt: fb.submittedAt.toISOString(),
      questions: FEEDBACK_QUESTIONS,
      ratingLabels: RATING_LABELS,
    };
  },
};

/** Whether a conditional question's trigger answer is satisfied. */
function conditionMet(q: FeedbackQuestion, answers: FeedbackAnswers): boolean {
  if (!q.showIf) return true;
  const trigger = answers[q.showIf.questionId];
  return typeof trigger === 'string' && q.showIf.in.includes(trigger);
}

/** Validate + coerce a single answer to its stored form. */
function validateAnswer(q: FeedbackQuestion, raw: unknown): unknown {
  switch (q.type) {
    case 'rating5': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new FeedbackValidationError(`${q.label}: pick a rating from 1 to 5.`);
      }
      return n;
    }
    case 'nps': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        throw new FeedbackValidationError(`${q.label}: pick a value from 0 to 10.`);
      }
      return n;
    }
    case 'email': {
      const v = clean(raw, MAX_TEXT);
      if (!EMAIL_RE.test(v)) throw new FeedbackValidationError('Enter a valid email address.');
      return v;
    }
    case 'tel': {
      const digits = clean(raw, 40).replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        throw new FeedbackValidationError('Enter a valid mobile number.');
      }
      return digits;
    }
    case 'textarea':
      return clean(raw, MAX_LONG);
    case 'text':
    case 'sam':
      return clean(raw, MAX_TEXT);
    case 'single': {
      const v = clean(raw, MAX_TEXT);
      if (q.options && !q.options.includes(v)) {
        throw new FeedbackValidationError(`${q.label}: invalid choice.`);
      }
      return v;
    }
    case 'multi': {
      if (!Array.isArray(raw)) throw new FeedbackValidationError(`${q.label}: invalid selection.`);
      const allowed = new Set(q.options ?? []);
      return raw
        .map((v) => clean(v, MAX_TEXT))
        .filter(Boolean)
        // Keep known options; keep free text only when the question allows "Other".
        .filter((v) => allowed.has(v) || q.allowOther)
        .slice(0, 30);
    }
    default:
      return clean(raw, MAX_TEXT);
  }
}
