/**
 * Feedback survey question catalog — the single source of truth for both the
 * public form (rendering) and the server (validation + scoring). Served as-is
 * by GET /feedback/form so the frontend never hard-codes questions.
 *
 * Sourced from "Online form (1).docx" (Gazon Customer Feedback & Service
 * Assessment) plus the mandatory added "Your SAM" dropdown.
 */

export type FeedbackQuestionType =
  | 'text'
  | 'email'
  | 'tel'
  | 'textarea'
  | 'rating5' // Excellent(5) → Very Poor(1)
  | 'nps' // 0–10 recommend score
  | 'single' // one-of options
  | 'multi' // any-of options
  | 'sam'; // "Your SAM" dropdown, options filled from SAM users at runtime

export type FeedbackQuestion = {
  id: string;
  section: number;
  label: string;
  type: FeedbackQuestionType;
  required: boolean;
  options?: string[];
  /** multi/single may include a free-text "Other" entry. */
  allowOther?: boolean;
  /** rating5 questions with isRating feed the overall score average. */
  isRating?: boolean;
  /** Conditional display: show only when another answer is one of `in`. */
  showIf?: { questionId: string; in: string[] };
  help?: string;
};

export const FEEDBACK_SECTIONS: { id: number; title: string }[] = [
  { id: 1, title: 'Customer Information' },
  { id: 2, title: 'Internet Service Feedback' },
  { id: 3, title: 'Additional Services' },
  { id: 4, title: 'Business Requirements' },
];

/** The two form steps, each grouping sections (per "2 pages, max 3"). */
export const FEEDBACK_STEPS: { title: string; sections: number[] }[] = [
  { title: 'About you & your service', sections: [1, 2] },
  { title: 'Services & requirements', sections: [3, 4] },
];

export const RATING_LABELS: Record<number, string> = {
  5: 'Excellent',
  4: 'Good',
  3: 'Average',
  2: 'Poor',
  1: 'Very Poor',
};

export const FEEDBACK_QUESTIONS: FeedbackQuestion[] = [
  // ── Section 1: Customer Information ──────────────────────────────────────
  { id: 'q1', section: 1, label: 'Company Name', type: 'text', required: true },
  { id: 'q2', section: 1, label: 'Contact Person', type: 'text', required: true },
  { id: 'q3', section: 1, label: 'Designation', type: 'text', required: false },
  { id: 'q4', section: 1, label: 'Email Address', type: 'email', required: true },
  { id: 'q5', section: 1, label: 'Mobile Number', type: 'tel', required: true },
  // Q6 "Service Manager Name" intentionally removed — the mandatory "Your SAM"
  // dropdown below covers it without the redundant free-text field.
  {
    id: 'yourSam',
    section: 1,
    label: 'Your SAM',
    type: 'sam',
    required: true,
    help: 'Select the Gazon SAM who handles your account.',
  },

  // ── Section 2: Internet Service Feedback ────────────────────────────────
  {
    id: 'q7',
    section: 2,
    label: 'How satisfied are you with Gazon Communication?',
    type: 'rating5',
    required: true,
    isRating: true,
  },
  {
    id: 'q8',
    section: 2,
    label: 'How reliable is the Gazon internet connection?',
    type: 'rating5',
    required: true,
    isRating: true,
  },
  {
    id: 'q9',
    section: 2,
    label: 'How satisfied are you with our technical (NOC & Field) support?',
    type: 'rating5',
    required: true,
    isRating: true,
  },
  {
    id: 'q10',
    section: 2,
    label: 'How likely are you to recommend Gazon Communication to others?',
    type: 'nps',
    required: true,
    help: '0 = Not likely, 10 = Highly likely.',
  },

  // ── Section 3: Additional Services ──────────────────────────────────────
  {
    id: 'q11',
    section: 3,
    label: 'Which services are you currently using from Gazon Communication?',
    type: 'multi',
    required: false,
    options: [
      'Internet / Broadband (ISP)',
      'Managed Wi-Fi',
      'IT Infrastructure Solutions',
      'Cloud Services',
      'Network Security / Firewall',
      'CCTV & Surveillance',
      'Server & Storage Solutions',
      'Backup & Disaster Recovery',
      'Annual Maintenance Contract (AMC)',
      'None of the Above',
    ],
  },
  {
    id: 'q12',
    section: 3,
    label: 'Are you currently using these services from another provider?',
    type: 'single',
    required: false,
    options: ['Yes', 'No'],
  },
  {
    id: 'q13',
    section: 3,
    label: 'Which services are you currently sourcing from another vendor?',
    type: 'multi',
    required: false,
    allowOther: true,
    showIf: { questionId: 'q12', in: ['Yes'] },
    options: [
      'Cloud Services',
      'IT Infrastructure',
      'Cyber Security',
      'Firewall',
      'CCTV',
      'Servers & Storage',
      'Data Backup',
      'Managed IT Support',
    ],
  },
  {
    id: 'q14',
    section: 3,
    label: "Would you be interested in learning more about Gazon Communication's additional services?",
    type: 'single',
    required: false,
    options: ['Yes', 'Maybe', 'No'],
  },
  {
    id: 'q15',
    section: 3,
    label: 'Which services are you interested in?',
    type: 'multi',
    required: false,
    allowOther: true,
    showIf: { questionId: 'q14', in: ['Yes', 'Maybe'] },
    options: [
      'Microsoft 365',
      'Cloud Migration',
      'Azure / AWS Cloud',
      'Cyber Security',
      'Firewall Solutions',
      'Network Design',
      'CCTV Solutions',
      'Server Virtualization',
      'Data Backup & Recovery',
      'IT Infrastructure Upgrade',
      'Managed IT Services',
    ],
  },

  // ── Section 4: Business Requirements ────────────────────────────────────
  {
    id: 'q16',
    section: 4,
    label: 'Are you planning any IT or infrastructure upgrades within the next 12 months?',
    type: 'single',
    required: false,
    options: ['Yes', 'No', 'Maybe'],
  },
  {
    id: 'q17',
    section: 4,
    label: 'If yes, please select the areas',
    type: 'multi',
    required: false,
    allowOther: true,
    showIf: { questionId: 'q16', in: ['Yes'] },
    options: [
      'Office Expansion',
      'Internet Upgrade',
      'Cloud Adoption',
      'Cyber Security',
      'Server Refresh',
      'Wi-Fi Upgrade',
      'CCTV Installation',
      'Backup Solution',
    ],
  },
  {
    id: 'q18',
    section: 4,
    label: 'Would you like one of Gazon’s solution experts to contact you?',
    type: 'single',
    required: false,
    options: ['Yes', 'No'],
  },
  {
    id: 'q19',
    section: 4,
    label: 'Preferred Contact Method',
    type: 'single',
    required: false,
    options: ['Phone', 'Email', 'WhatsApp'],
  },
  {
    id: 'q20',
    section: 4,
    label: 'Any additional comments or suggestions?',
    type: 'textarea',
    required: false,
  },
];

/** Rating question ids that feed the overall interest score. */
export const RATING_QUESTION_IDS = FEEDBACK_QUESTIONS.filter((q) => q.isRating).map(
  (q) => q.id,
);

export type InterestLevel = 'Very High' | 'High' | 'Medium' | 'Low' | 'Very Low';

/** Map a 1–5 average to an interest band. */
export function interestLevelFor(avg: number): InterestLevel {
  if (avg >= 4.5) return 'Very High';
  if (avg >= 3.5) return 'High';
  if (avg >= 2.5) return 'Medium';
  if (avg >= 1.5) return 'Low';
  return 'Very Low';
}
