const KEYWORDS = [
  'assessment not starting',
  'unable to start assessment',
  'not able to start',
  'not able to start the test',
  'camera not allowed',
  'test not starting',
  'unable to click start',
  'start button not working',
  'camera permission issue',
  'microphone permission issue',
  'camera/mic permission issue',
  'proctoring permission issue',
  'not start',
  'not starting',
  'cannot start',
  "can't start",
  'wont start',
  'will not start',
  'not working',
  'not workng',
  'assessment not working',
  'test not working',
  'button not working',
  'start not working',
  'start test button disabled',
  'start button disabled',
  'test button disabled',
  'button disabled',
];

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9\s'/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collapseRepeats(text) {
  return text.replace(/([a-z])\1{2,}/gi, '$1');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const curr = Math.min(row[j] + 1, prev + 1, row[j - 1] + cost);
      row[j - 1] = prev;
      prev = curr;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

function maxEditDistance(word) {
  if (word.length <= 4) return 1;
  if (word.length <= 8) return 2;
  return 3;
}

function fuzzyWordMatch(word, term) {
  const w = collapseRepeats(word);
  const t = collapseRepeats(term);
  if (!w || !t) return false;
  if (w === t) return true;
  // Avoid false positives like "not" matching inside "starting"
  if (w.length >= 4 && t.includes(w)) return true;
  if (t.length >= 4 && w.includes(t)) return true;
  return levenshtein(w, t) <= maxEditDistance(t);
}

function words(text) {
  return text.split(/\s+/).filter((w) => w.length > 1);
}

function textHasTerm(text, term) {
  if (term.length >= 4 && text.includes(term)) return true;
  if (term.length <= 3) {
    return words(text).some((w) => w === term);
  }
  return words(text).some((w) => fuzzyWordMatch(w, term));
}

function exactKeywordMatch(combined) {
  const collapsed = collapseRepeats(combined);
  return KEYWORDS.some((kw) => {
    const k = collapseRepeats(kw);
    return combined.includes(kw) || collapsed.includes(k);
  });
}

function fuzzyPhraseMatch(combined) {
  const collapsed = collapseRepeats(combined);
  return KEYWORDS.some((kw) => {
    const parts = kw.split(/\s+/).filter((p) => p.length > 2);
    if (parts.length < 2) return false;
    if (parts.includes('not')) return false;
    return parts.every((part) => textHasTerm(collapsed, part));
  });
}

function extractEmailAddress(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1].trim() : fromHeader.trim();
}

function extractDisplayName(fromHeader) {
  if (!fromHeader) return null;
  const match = fromHeader.match(/^(.+?)\s*<[^>]+>/);
  if (match) {
    const name = match[1].replace(/^["']|["']$/g, '').trim();
    if (name) return name;
  }
  return null;
}

function nameFromEmail(email) {
  if (!email) return null;
  const local = email.split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

function extractCandidateName(fromHeader) {
  const displayName = extractDisplayName(fromHeader);
  if (displayName) return displayName;

  const email = extractEmailAddress(fromHeader);
  const inferred = nameFromEmail(email);
  return inferred || 'Candidate';
}

module.exports = {
  KEYWORDS,
  normalize,
  collapseRepeats,
  textHasTerm,
  exactKeywordMatch,
  fuzzyPhraseMatch,
  extractCandidateName,
  extractEmailAddress,
};
