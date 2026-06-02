function assessmentNotStartingReplyHtml(candidateName) {
  return `<p>Dear <strong>${candidateName}</strong>,</p>

<p>Thank you for reaching out to us regarding the issue you are experiencing with starting your assessment.</p>

<p>Please ensure that <strong>camera and microphone permissions</strong> are enabled for <strong>Google Chrome</strong> so that you can select the <strong>Start</strong> button.</p>

<p>If you continue to experience issues, kindly enable all required permissions and reload the page.</p>

<p>If the problem persists, please try the following:</p>
<ol>
  <li>Take the test in <strong>incognito mode</strong>.</li>
  <li>Switch to a <strong>different device</strong>.</li>
</ol>

<p>We hope this helps you proceed with your assessment.</p>

<p>Regards,<br><strong>Candidate Support Team</strong></p>`;
}

function assessmentNotStartingReply(candidateName) {
  const { htmlToPlain } = require('../src/emailHtml');
  return htmlToPlain(assessmentNotStartingReplyHtml(candidateName));
}

module.exports = { assessmentNotStartingReply, assessmentNotStartingReplyHtml };
