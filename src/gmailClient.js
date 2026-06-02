const { google } = require('googleapis');
const { htmlToPlain } = require('./emailHtml');
const logger = require('./logger');

function createGmailClient(auth) {
  return google.gmail({ version: 'v1', auth });
}

async function searchMessages(gmail, query) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });
  return res.data.messages || [];
}

function getHeader(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

function extractHtml(payload) {
  if (!payload) return '';

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const html = extractHtml(part);
      if (html) return html;
    }
  }

  return '';
}

function extractPlainText(payload) {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }

  if (payload.body?.data && payload.mimeType === 'text/plain') {
    return decodeBase64Url(payload.body.data);
  }

  return '';
}

function extractMessageBody(payload) {
  const plain = extractPlainText(payload);
  if (plain) return plain;
  const html = extractHtml(payload);
  if (html) return htmlToPlain(html);
  if (payload?.body?.data) {
    const raw = decodeBase64Url(payload.body.data);
    if (payload.mimeType === 'text/html') return htmlToPlain(raw);
    return raw;
  }
  return '';
}

function messageFromApi(msg, body = '') {
  const headers = msg.payload?.headers || [];
  return {
    messageId: msg.id,
    threadId: msg.threadId,
    internalDate: Number(msg.internalDate),
    labelIds: msg.labelIds || [],
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    messageIdHeader: getHeader(headers, 'Message-ID') || getHeader(headers, 'Message-Id'),
    references: getHeader(headers, 'References'),
    body,
  };
}

/** Lightweight fetch — Subject + headers only (no body). */
async function getMessageMetadata(gmail, messageId) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Message-ID', 'Message-Id', 'References'],
  });
  return messageFromApi(res.data, '');
}

async function getMessage(gmail, messageId) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return messageFromApi(res.data, extractMessageBody(res.data.payload));
}

async function findOrCreateLabel(gmail, labelName) {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const existing = (res.data.labels || []).find((l) => l.name === labelName);
  if (existing) return existing.id;

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  logger.info(`Created label: ${labelName}`);
  return created.data.id;
}

async function modifyMessageLabels(gmail, messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds,
        removeLabelIds,
      },
    });
    logger.info('Message labels modified successfully', {
      messageId,
      addLabelIds,
      removeLabelIds,
    });
  } catch (error) {
    logger.error('Failed to modify message labels', {
      messageId,
      addLabelIds,
      removeLabelIds,
      error: error.message,
    });
    throw error; // Re-throw so caller knows it failed
  }
}

async function modifyThreadLabels(gmail, threadId, { addLabelIds = [], removeLabelIds = [] } = {}) {
  try {
    await gmail.users.threads.modify({
      userId: 'me',
      id: threadId,
      requestBody: {
        addLabelIds,
        removeLabelIds,
      },
    });
    logger.info('Thread labels modified successfully', {
      threadId,
      addLabelIds,
      removeLabelIds,
    });
  } catch (error) {
    logger.error('Failed to modify thread labels', {
      threadId,
      addLabelIds,
      removeLabelIds,
      error: error.message,
    });
    throw error;
  }
}

async function applyLabel(gmail, messageId, labelId) {
  return modifyMessageLabels(gmail, messageId, { addLabelIds: [labelId] });
}

module.exports = {
  createGmailClient,
  searchMessages,
  getMessageMetadata,
  getMessage,
  findOrCreateLabel,
  applyLabel,
  modifyMessageLabels,
  modifyThreadLabels,
};
