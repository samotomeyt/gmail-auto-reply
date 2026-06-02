/** Otomeyt support subjects: <assessmentKey>-<description> e.g. srnVnEHFqfD3W7V3K4o3-B pharm */

const DEFAULT_MIN_KEY_LENGTH = 8;

function normalizeSubject(subject) {
  let s = (subject || '').trim();
  const prefixRe = /^(re|fwd|fw):\s*/i;
  while (prefixRe.test(s)) {
    s = s.replace(prefixRe, '').trim();
  }
  return s;
}

function matchesSupportSubject(subject, minKeyLength = DEFAULT_MIN_KEY_LENGTH) {
  const normalized = normalizeSubject(subject);
  if (!normalized) return false;
  const re = new RegExp(`^[A-Za-z0-9]{${minKeyLength},}-.+`);
  return re.test(normalized);
}

function parseAssessmentKeyFromSubject(subject, minKeyLength = DEFAULT_MIN_KEY_LENGTH) {
  const normalized = normalizeSubject(subject);
  if (!matchesSupportSubject(normalized, minKeyLength)) return null;
  const dash = normalized.indexOf('-');
  return normalized.slice(0, dash);
}

module.exports = {
  normalizeSubject,
  matchesSupportSubject,
  parseAssessmentKeyFromSubject,
  DEFAULT_MIN_KEY_LENGTH,
};
