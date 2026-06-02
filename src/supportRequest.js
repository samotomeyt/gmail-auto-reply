function normalizeSupportBody(body) {
  return (body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\*+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Value must be on the same line as the label (\s* must not span blank lines). */
function getField(body, label) {
  const re = new RegExp(`^\\s*${escapeRegExp(label)}:\\s*([^\\n]*)`, 'im');
  const match = body.match(re);
  return match ? match[1].trim() : '';
}

function isValidCandidateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((value || '').trim());
}

/**
 * Parses Otomeyt "Product Support Request" notification emails.
 * Returns null if the body does not match the expected format.
 */
function parseSupportRequest(body) {
  const normalized = normalizeSupportBody(body);
  if (!normalized || !/\bproduct\s+support\s+request\b/i.test(normalized)) {
    return null;
  }
  body = normalized;

  const issueMatch = body.match(
    /^\s*Issue:\s*([\s\S]*?)(?=\n\s*Thank you for your attention|\n\s*Candidate |\n\s*Subject:|\n\s*Regards,|$)/im,
  );
  let issue = issueMatch ? issueMatch[1].trim() : getField(body, 'Issue');
  issue = issue.replace(/\n{3,}/g, '\n').trim();

  let candidateEmail = getField(body, 'Candidate Email ID');
  if (candidateEmail && !isValidCandidateEmail(candidateEmail)) {
    candidateEmail = '';
  }
  const candidateFullName = getField(body, 'Candidate Full Name');

  if (!issue && !candidateEmail) {
    return null;
  }

  return {
    candidateFullName,
    candidateEmail,
    candidatePhone: getField(body, 'Candidate Phone'),
    assessmentKey: getField(body, 'Candidate Assessment Key'),
    issueSubject: getField(body, 'Subject'),
    issue,
  };
}

function classificationText(supportRequest, emailSubject) {
  const parts = [
    emailSubject,
    supportRequest.issueSubject,
    supportRequest.issue,
  ].filter(Boolean);
  return parts.join('\n');
}

module.exports = {
  parseSupportRequest,
  classificationText,
  isValidCandidateEmail,
};
