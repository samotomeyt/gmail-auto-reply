const OpenAI = require('openai');
const logger = require('./logger');
const {
  KEYWORDS,
  normalize,
  collapseRepeats,
  textHasTerm,
  exactKeywordMatch,
  fuzzyPhraseMatch,
} = require('./parser');

const SYSTEM_SENDER_HINTS = [
  'noreply',
  'no-reply',
  'mailer-daemon',
  'accounts.google.com',
  'google.com',
];

const SYSTEM_SUBJECT_HINTS = [
  'security alert',
  'account was recovered',
  'verification code',
  'password reset',
  'two-step',
  'upi txn',
  'payment',
];

const MID_ASSESSMENT_PHRASES = [
  'reattempt',
  're attempt',
  're-attempt',
  'already submitted',
  'was submitted',
  'before the assessment was submitted',
  'before the test was submitted',
  'sections did not',
  'section did not',
  'sections not',
  'did not function',
  'could not complete',
  'unable to complete',
  'unable to access and complete',
  'could not answer',
  'during the test',
  'during the assessment',
  'while taking the test',
  'while taking the assessment',
  'mid assessment',
  'in the middle of',
  'alternative solution',
  'review this issue',
  'request your assistance',
  'faced a technical issue where',
];

function isMidAssessmentOrReattempt(combined) {
  return MID_ASSESSMENT_PHRASES.some((p) => combined.includes(p));
}

function isSystemOrUnrelated(from, subject, body) {
  const fromL = (from || '').toLowerCase();
  if (SYSTEM_SENDER_HINTS.some((h) => fromL.includes(h))) return true;

  const text = `${subject || ''} ${body || ''}`.toLowerCase();
  return SYSTEM_SUBJECT_HINTS.some((h) => text.includes(h));
}

function hasAssessmentContext(combined) {
  const collapsed = collapseRepeats(combined);
  return (
    textHasTerm(collapsed, 'assessment') ||
    textHasTerm(collapsed, 'assesment') ||
    textHasTerm(collapsed, 'proctoring') ||
    (textHasTerm(collapsed, 'test') &&
      (collapsed.includes('not start') ||
        collapsed.includes('not starting') ||
        collapsed.includes('start button') ||
        hasButtonDisabledPhrase(collapsed) ||
        hasNotWorkingPhrase(collapsed) ||
        textHasTerm(collapsed, 'starting')))
  );
}

function hasNotWorkingPhrase(collapsed) {
  if (
    collapsed.includes('not working') ||
    collapsed.includes('not workng') ||
    collapsed.includes('not wrking') ||
    collapsed.includes('is not working') ||
    collapsed.includes("isn't working") ||
    collapsed.includes('isnt working')
  ) {
    return true;
  }
  const parts = collapsed.split(/\s+/);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'not' && textHasTerm(parts[i + 1], 'working')) return true;
  }
  return false;
}

function hasButtonDisabledPhrase(collapsed) {
  if (
    collapsed.includes('button disabled') ||
    collapsed.includes('button disbled') ||
    collapsed.includes('button disable') ||
    collapsed.includes('start test button disabled')
  ) {
    return true;
  }
  return textHasTerm(collapsed, 'button') && textHasTerm(collapsed, 'disabled');
}

function hasNotStartPhrase(collapsed) {
  if (
    collapsed.includes('not start') ||
    collapsed.includes('not starting') ||
    collapsed.includes('not strat') ||
    collapsed.includes('not srart')
  ) {
    return true;
  }
  const parts = collapsed.split(/\s+/);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'not' && textHasTerm(parts[i + 1], 'start')) return true;
  }
  return false;
}

function hasStartBlockerSymptom(combined) {
  const collapsed = collapseRepeats(combined);
  return (
    hasNotStartPhrase(collapsed) ||
    hasNotWorkingPhrase(collapsed) ||
    hasButtonDisabledPhrase(collapsed) ||
    collapsed.includes('unable to start') ||
    collapsed.includes('not able to start') ||
    collapsed.includes('unable to begin') ||
    collapsed.includes('cannot start') ||
    collapsed.includes('can not start') ||
    collapsed.includes('cant start') ||
    collapsed.includes("can't start") ||
    collapsed.includes('wont start') ||
    collapsed.includes("doesn't start") ||
    collapsed.includes('doesnt start') ||
    collapsed.includes('does not start') ||
    collapsed.includes('start button') ||
    collapsed.includes('camera permission') ||
    collapsed.includes('camera not allowed') ||
    collapsed.includes('camera not working') ||
    collapsed.includes('camera blocked') ||
    collapsed.includes('microphone permission') ||
    collapsed.includes('microphone not allowed') ||
    collapsed.includes('mic not allowed') ||
    collapsed.includes('camera/mic') ||
    (textHasTerm(collapsed, 'permission') &&
      (textHasTerm(collapsed, 'camera') || textHasTerm(collapsed, 'microphone') || textHasTerm(collapsed, 'mic')))
  );
}

/** Strict local pre-filter — keyword/typo hint only; does NOT approve a reply by itself */
function hasKeywordHint(subject, body) {
  const combined = normalize(`${subject} ${body}`);
  if (!combined) return false;

  if (isMidAssessmentOrReattempt(combined)) return false;
  if (!hasStartBlockerSymptom(combined)) return false;

  if (exactKeywordMatch(combined)) return true;
  if (fuzzyPhraseMatch(combined)) return true;

  return hasAssessmentContext(combined) && hasStartBlockerSymptom(combined);
}

async function confirmWithOpenAI(config, subject, body) {
  const client = new OpenAI({ apiKey: config.openaiApiKey });
  const response = await client.chat.completions.create({
    model: config.openaiModel,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `You classify inbound support emails for an online assessment platform.

Reply with exactly one word: YES or NO.

YES ONLY if the candidate cannot START/BEGIN the assessment (before or at entry), for example:
- assessment/test not starting, not start, not strat (typos ok)
- start button disabled, not working, cannot click start
- camera/microphone/permission/proctoring blocks them from clicking Start

NO if (even if they mention assessment/test):
- they already took or submitted the assessment
- sections/questions failed during the test, could not complete sections, timed sections broken
- they want reattempt, review, alternative solution, or manual correction
- general technical issues during the test after it already started
- security, payment, HR, or unrelated topics

When in doubt, reply NO. Only YES for clear "cannot start" / "start button" / permission-to-start problems.

Related keywords: ${KEYWORDS.join(', ')}`,
      },
      {
        role: 'user',
        content: `Subject: ${subject || '(empty)'}\n\nBody:\n${body || '(empty)'}`,
      },
    ],
  });

  const answer = response.choices[0]?.message?.content?.trim().toUpperCase();
  return answer?.startsWith('YES') === true;
}

/**
 * Returns { reply: boolean, reason: string }
 */
async function shouldAutoReply(subject, body, from, config) {
  const combined = normalize(`${subject} ${body}`);

  if (isSystemOrUnrelated(from, subject, body)) {
    return { reply: false, reason: 'system or unrelated email' };
  }

  if (isMidAssessmentOrReattempt(combined)) {
    return { reply: false, reason: 'mid-assessment or reattempt (not start issue)' };
  }

  if (!hasKeywordHint(subject, body)) {
    return { reply: false, reason: 'no assessment-start keyword hint' };
  }

  if (!config.openaiApiKey) {
    logger.warn('OPENAI_API_KEY required for confirmation; skipping');
    return { reply: false, reason: 'openai key missing' };
  }

  try {
    const confirmed = await confirmWithOpenAI(config, subject, body);
    if (!confirmed) {
      return { reply: false, reason: 'openai: not assessment-start issue' };
    }
    logger.info('OpenAI confirmed assessment-start issue');
    return { reply: true, reason: 'keyword hint + openai confirmed' };
  } catch (err) {
    logger.error('OpenAI confirmation failed:', err.message);
    return { reply: false, reason: 'openai error' };
  }
}

module.exports = { shouldAutoReply, hasKeywordHint, isSystemOrUnrelated };
