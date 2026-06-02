const logger = require('./logger');
const { extractEmailAddress } = require('./parser');
const { htmlToPlain } = require('./emailHtml');

function encodeBase64Url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function formatFromAddress(email, displayName) {
  if (!email) return '';
  const trimmedName = (displayName || '').trim();
  if (trimmedName) return `${trimmedName} <${email}>`;
  return email;
}

function buildReplySubject(subject) {
  const trimmed = (subject || '').trim();
  return !trimmed ? 'Re:' : trimmed.startsWith('Re:') ? trimmed : `Re: ${trimmed}`;
}

function buildRawReply({
  from,
  to,
  cc,
  subject,
  htmlBody,
  threadId,
  inReplyTo,
  references,
}) {
  const replySubject = buildReplySubject(subject);
  const refLine = references
    ? `${references} ${inReplyTo || ''}`.trim()
    : inReplyTo || '';

  const plainBody = htmlToPlain(htmlBody);
  const boundary = `boundary_${Date.now()}`;

  const mime = [];
  if (from) mime.push(`From: ${from}`);
  mime.push(`To: ${to}`);
  if (cc) mime.push(`Cc: ${cc}`);
  mime.push(`Subject: ${replySubject}`);

  if (inReplyTo) mime.push(`In-Reply-To: ${inReplyTo}`);
  if (refLine) mime.push(`References: ${refLine}`);
  mime.push('MIME-Version: 1.0');
  mime.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  mime.push('');
  mime.push(`--${boundary}`);
  mime.push('Content-Type: text/plain; charset=utf-8');
  mime.push('');
  mime.push(plainBody);
  mime.push('');
  mime.push(`--${boundary}`);
  mime.push('Content-Type: text/html; charset=utf-8');
  mime.push('');
  mime.push(htmlBody);
  mime.push('');
  mime.push(`--${boundary}--`);

  const raw = mime.join('\r\n');
  return { raw: encodeBase64Url(raw), threadId };
}

async function sendReply(gmail, message, replyBody, dryRun, options = {}) {
  const to =
    options.replyTo ||
    extractEmailAddress(message.from) ||
    message.from;
  const cc = options.cc || '';
  const from = formatFromAddress(options.fromEmail, options.fromName);
  const { raw, threadId } = buildRawReply({
    from,
    to,
    cc,
    subject: message.subject,
    htmlBody: replyBody,
    threadId: message.threadId,
    inReplyTo: message.messageIdHeader,
    references: message.references,
  });

  if (dryRun) {
    const previewSubject = buildReplySubject(message.subject);
    logger.info('[DRY_RUN] Would send reply', {
      from: from || undefined,
      to,
      cc: cc || undefined,
      subject: previewSubject,
      threadId,
      messageId: message.messageId,
      format: 'html',
    });
    return {
      sent: false,
      dryRun: true,
      from: from || undefined,
      to,
      cc: cc || undefined,
      replySubject: previewSubject,
      threadId,
      messageId: message.messageId,
      format: 'html',
    };
  }

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId,
    },
  });

  logger.info('Reply sent', {
    from: from || undefined,
    to,
    cc: cc || undefined,
    threadId,
    messageId: message.messageId,
    format: 'html',
  });
  return {
    sent: true,
    dryRun: false,
    from: from || undefined,
    to,
    cc: cc || undefined,
    replySubject: buildReplySubject(message.subject),
    threadId,
    messageId: message.messageId,
    format: 'html',
  };
}

module.exports = { buildRawReply, sendReply };
