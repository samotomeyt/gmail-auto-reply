const OpenAI = require('openai');
const { KEYWORDS } = require('./parser');
const {
  assessmentNotStartingReplyHtml,
} = require('../templates/assessmentNotStarting');
const { wrapHtmlDocument, sanitizeHtmlFragment } = require('./emailHtml');
const logger = require('./logger');
const monitor = require('./monitor');

const BASE_TEMPLATE_HTML = assessmentNotStartingReplyHtml('{{candidateName}}');

function buildPrompt({ candidateName, subject, body }) {
  return `You are writing a formal HTML support email for Candidate Support Team (online assessments).
This email was confirmed as: candidate cannot start their online assessment due to a technical issue.

Incoming email:
- Candidate name: ${candidateName}
- Subject: ${subject || '(empty)'}
- Body:
${body}

Write a professional, formal HTML email body (fragment only, no <html>/<head>/<body> tags) that:
- Opens with <p>Dear <strong>${candidateName}</strong>,</p> and thanks them for contacting support
- Addresses their specific issue (camera, microphone, start button, permissions, proctoring, etc.)
- Includes the same troubleshooting guidance as this reference (rephrase professionally; do not omit steps):
${BASE_TEMPLATE_HTML.replace(/\{\{candidateName\}\}/g, candidateName)}
- Use <p> for each paragraph
- Use <ol><li>...</li></ol> for numbered steps — each step in its own <li>, never two steps in one line
- Use <strong> for important terms: Google Chrome, camera, microphone, permissions, Start button, incognito mode, etc.
- Close with <p>Regards,<br><strong>Candidate Support Team</strong></p>
- Tone: formal, clear, corporate support
- Do not mention AI, automation, or keywords
- Do not use markdown
- Return only the HTML fragment`;
}

async function generateReply(config, { candidateName, subject, body }) {
  if (!config.openaiApiKey) {
    logger.warn('OPENAI_API_KEY missing, using default template');
    return wrapHtmlDocument(assessmentNotStartingReplyHtml(candidateName));
  }

  const client = new OpenAI({ apiKey: config.openaiApiKey });

  try {
    const response = await client.chat.completions.create({
      model: config.openaiModel,
      messages: [
        {
          role: 'system',
          content:
            'You write formal HTML support emails. Use <p>, <ol><li>, and <strong> only. ' +
            'Never put multiple numbered steps in a single paragraph or line.',
        },
        { role: 'user', content: buildPrompt({ candidateName, subject, body }) },
      ],
      temperature: 0.3,
    });

    const fragment = response.choices[0]?.message?.content?.trim();
    if (!fragment) throw new Error('Empty OpenAI response');
    logger.info('Generated HTML reply with OpenAI');
    return wrapHtmlDocument(sanitizeHtmlFragment(fragment));
  } catch (err) {
    await monitor.alert(monitor.ALERT.OPENAI, 'OpenAI reply generation failed; using fallback template', {
      error: err.message,
      subject,
    });
    logger.warn('OpenAI failed, using default template:', err.message);
    return wrapHtmlDocument(assessmentNotStartingReplyHtml(candidateName));
  }
}

module.exports = { generateReply };
