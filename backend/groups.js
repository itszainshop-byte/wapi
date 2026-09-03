import express from 'express';

const router = express.Router();
const DETACHED_FRAME_ERROR = /detached frame|Navigating frame was detached|LifecycleWatcher disposed|Target page, context or browser has been closed|Target closed|Execution context was destroyed|Session closed/i;
const TRANSIENT_STORE_ERROR = /Cannot read properties of undefined \(reading 'getChats'\)|window\.Store|Runtime\.callFunctionOn/i;
const RECOVERY_COOLDOWN_MS = process.env.SESSION_RECOVERY_COOLDOWN_MS
  ? Number(process.env.SESSION_RECOVERY_COOLDOWN_MS)
  : 30000;
const RECOVER_CLIENT_TIMEOUT_MS = process.env.SESSION_RECOVER_CALL_TIMEOUT_MS
  ? Number(process.env.SESSION_RECOVER_CALL_TIMEOUT_MS)
  : 15000;
const REQUEST_RECOVERY_THROTTLE_MS = process.env.SESSION_REQUEST_RECOVERY_THROTTLE_MS
  ? Number(process.env.SESSION_REQUEST_RECOVERY_THROTTLE_MS)
  : 15000;
const RECOVERABLE_FAILURE_BLOCK_THRESHOLD = process.env.SESSION_RECOVERABLE_FAILURE_BLOCK_THRESHOLD
  ? Number(process.env.SESSION_RECOVERABLE_FAILURE_BLOCK_THRESHOLD)
  : 3;

function isRecoveryLockOrTimeoutError(error) {
  if (!error) {
    return false;
  }

  if (
    error?.code === 'SESSION_PROFILE_LOCKED'
    || error?.code === 'SESSION_RECOVERY_TIMEOUT'
    || error?.code === 'SESSION_RECOVERY_THROTTLED'
  ) {
    return true;
  }

  const message = String(error?.message || '');
  return /session profile lock|already running for/i.test(message);
}

function isRecoverableClientError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  const combined = `${name}: ${message}`;
  const normalizedMessage = message.trim().toLowerCase();

  if (DETACHED_FRAME_ERROR.test(combined)) return true;
  if (TRANSIENT_STORE_ERROR.test(combined)) return true;
  if (normalizedMessage === 'r') return true;
  if (/^r\s*:\s*r$/i.test(combined.trim())) return true;
  if (name === 'r' && message === 'r') return true;

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const timeoutError = new Error(message);
        timeoutError.code = 'SESSION_RECOVERY_TIMEOUT';
        reject(timeoutError);
      }, timeoutMs);
    }),
  ]);
}

async function tryRecoverClient(session, reason) {
  if (!session || typeof session.recoverClient !== 'function') {
    return null;
  }

  const lastAttemptAt = Number(session.lastRequestRecoverAt || 0);
  if (lastAttemptAt && Date.now() - lastAttemptAt < REQUEST_RECOVERY_THROTTLE_MS) {
    const throttledError = new Error(`Session recovery throttled (${reason})`);
    throttledError.code = 'SESSION_RECOVERY_THROTTLED';
    session.lastRecoverError = throttledError;
    return null;
  }

  session.lastRequestRecoverAt = Date.now();

  try {
    const recovered = await withTimeout(
      session.recoverClient(),
      RECOVER_CLIENT_TIMEOUT_MS,
      `Session recovery timed out (${reason})`,
    );
    session.lastRecoverError = null;
    session.recoverableRecoveryFailures = 0;
    return recovered;
  } catch (error) {
    session.lastRecoverError = error;
    console.warn('Session recovery attempt failed', reason, error?.message || error);
    return null;
  }
}

function normalizeSessionConnectedState(session) {
  if (!session) {
    return;
  }

  if (session.client && session.status === 'connected' && !session.connected) {
    session.status = 'starting';
  }

  if (!session.client && (session.status === 'connected' || session.connected)) {
    session.status = 'disconnected';
    session.connected = false;
    session.qr = null;
  }
}

function hasUsableConnectedClient(session) {
  return !!(session?.client && session?.connected && session?.status === 'connected');
}

function blockSessionRecovery(session, error) {
  if (!session) return;

  session.connected = false;
  session.status = 'disconnected';
  session.qr = null;
  session.client = null;
  session.recoveryBlockedUntil = Date.now() + RECOVERY_COOLDOWN_MS;

  console.warn('Blocking WhatsApp session recovery after repeated recoverable error', error?.message || error);
}

function registerRecoverableRecoveryFailure(session, error) {
  if (!session) {
    return RECOVERABLE_FAILURE_BLOCK_THRESHOLD;
  }

  session.recoverableRecoveryFailures = Number(session.recoverableRecoveryFailures || 0) + 1;
  const failures = session.recoverableRecoveryFailures;

  if (failures < RECOVERABLE_FAILURE_BLOCK_THRESHOLD) {
    console.warn(
      `WhatsApp session recover attempt failed (${failures}/${RECOVERABLE_FAILURE_BLOCK_THRESHOLD}); keeping recovery enabled`,
      error?.message || error,
    );
  }

  return failures;
}

async function withTransientRecoveryRetries(session, callback, { maxAttempts = 3, delayMs = 1000 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withRecoveredClient(session, callback);
    } catch (error) {
      lastError = error;
      if (!isRecoverableClientError(error) || attempt === maxAttempts) {
        throw error;
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function waitForConnectedSession(session, { timeoutMs = 7000, pollMs = 250 } = {}) {
  const terminalStates = new Set(['auth_failure']);
  if (!session) {
    return false;
  }

  normalizeSessionConnectedState(session);

  let recoveryAttempted = false;

  if (!hasUsableConnectedClient(session) && typeof session.recoverClient === 'function') {
    const blocked = session.recoveryBlockedUntil && session.recoveryBlockedUntil > Date.now();
    if (!blocked) {
      recoveryAttempted = true;
      void tryRecoverClient(session, 'wait_for_connected_initial');
    }
  }

  if (!session.connected && terminalStates.has(session.status)) {
    return false;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasUsableConnectedClient(session)) {
      return true;
    }

    if (!session) {
      return false;
    }

    if (!recoveryAttempted && !hasUsableConnectedClient(session) && typeof session.recoverClient === 'function') {
      const blocked = session.recoveryBlockedUntil && session.recoveryBlockedUntil > Date.now();
      if (!blocked) {
        recoveryAttempted = true;
        void tryRecoverClient(session, 'wait_for_connected_poll');
      }
    }

    if (terminalStates.has(session.status)) {
      return false;
    }

    await sleep(pollMs);
  }

  return hasUsableConnectedClient(session);
}

async function withRecoveredClient(session, callback) {
  normalizeSessionConnectedState(session);

  if (!session?.client) {
    if (
      typeof session?.recoverClient === 'function'
      && (!session?.recoveryBlockedUntil || session.recoveryBlockedUntil <= Date.now())
    ) {
      void tryRecoverClient(session, 'with_recovered_client_precheck');
    }

    if (session?.client) {
      return callback(session.client);
    }

    const sessionNotConnectedError = new Error('Session is not connected');
    sessionNotConnectedError.code = 'SESSION_NOT_CONNECTED';
    throw sessionNotConnectedError;
  }

  if (session?.recoveryBlockedUntil && session.recoveryBlockedUntil > Date.now()) {
    const sessionNotConnectedError = new Error('Session is not connected');
    sessionNotConnectedError.code = 'SESSION_NOT_CONNECTED';
    throw sessionNotConnectedError;
  }

  try {
    return await callback(session.client);
  } catch (error) {
    if (!session?.recoverClient || !isRecoverableClientError(error)) {
      throw error;
    }

    if (!session?.connected || session?.status !== 'connected') {
      const sessionNotConnectedError = new Error('Session is not connected');
      sessionNotConnectedError.code = 'SESSION_NOT_CONNECTED';
      throw sessionNotConnectedError;
    }

    console.warn('Recovering WhatsApp session after detached frame error', error?.message);
    const recoveredClient = await tryRecoverClient(session, 'with_recovered_client_runtime_error');
    if (!recoveredClient) {
      if (!isRecoveryLockOrTimeoutError(session?.lastRecoverError)) {
        const failures = registerRecoverableRecoveryFailure(session, error);
        if (failures >= RECOVERABLE_FAILURE_BLOCK_THRESHOLD) {
          blockSessionRecovery(session, error);
        }
      }
      const sessionNotConnectedError = new Error('Session is not connected');
      sessionNotConnectedError.code = 'SESSION_NOT_CONNECTED';
      throw sessionNotConnectedError;
    }

    if (session?.recoveryBlockedUntil > Date.now()) {
      const sessionNotConnectedError = new Error('Session is not connected');
      sessionNotConnectedError.code = 'SESSION_NOT_CONNECTED';
      throw sessionNotConnectedError;
    }

    const reconnected = await waitForConnectedSession(session, { timeoutMs: 20000, pollMs: 250 });
    if (!reconnected) {
      const sessionNotConnectedError = new Error('Session is not connected');
      sessionNotConnectedError.code = 'SESSION_NOT_CONNECTED';
      throw sessionNotConnectedError;
    }

    return callback(session.client);
  }
}

function getSessionResponseStatus(session) {
  if (!session) {
    return 'disconnected';
  }

  if (session.status === 'auth_failure') {
    return 'auth_failure';
  }

  if (session.status === 'connected' && session.client && session.connected) {
    return 'connected';
  }

  if (session.status === 'starting' || session.status === 'qr') {
    return session.status;
  }

  if (!session.client && session.status === 'connected') {
    return 'disconnected';
  }

  if (session.client && !session.connected) {
    return 'starting';
  }

  return 'disconnected';
}

async function getCachedChats(session) {
  if (Array.isArray(session.chatsCache)) {
    return session.chatsCache;
  }

  if (!session.chatsCachePromise) {
    session.chatsCachePromise = withTransientRecoveryRetries(session, async (client) => client.getChats())
      .then((chats) => {
        session.chatsCache = chats;
        return chats;
      })
      .finally(() => {
        session.chatsCachePromise = null;
      });
  }

  return session.chatsCachePromise;
}

router.get('/groups', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    normalizeSessionConnectedState(session);

    const connected = await waitForConnectedSession(session) || hasUsableConnectedClient(session);
    if (!connected) {
      const status = getSessionResponseStatus(session);
      return res.json({
        groups: [],
        pending: true,
        status: status === 'connected' ? 'starting' : status,
        message: 'Session is not connected yet',
      });
    }

    const chats = await getCachedChats(session);
    const groups = chats
      .filter(chat => chat.isGroup)
      .map(chat => ({
        id: chat.id._serialized,
        subject: chat.name,
        description: chat.description || null,
        participants: chat.participants?.map(p => ({
          id: p.id._serialized ?? p.id,
          isAdmin: p.isAdmin,
          isSuperAdmin: p.isSuperAdmin,
        })) || [],
      }));

    res.json({ groups });
  } catch (error) {
    if (error?.code === 'SESSION_NOT_CONNECTED') {
      const status = getSessionResponseStatus(req.sessionClient);
      return res.json({
        groups: [],
        pending: true,
        status: status === 'connected' ? 'starting' : status,
        message: 'Session is not connected yet',
      });
    }

    if (isRecoverableClientError(error)) {
      console.warn('GET /groups temporary WhatsApp session error', error?.message || error);
      return res.status(503).json({
        error: 'WhatsApp session is temporarily unavailable',
        retryable: true,
      });
    }

    console.error('GET /groups error', error);
    res.status(500).json({ error: 'Failed to load groups', message: error?.message ?? 'Unknown error' });
  }
});

router.post('/groups', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const { subject, participants, description } = req.body;
    if (!subject || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'subject and participants are required' });
    }

    const result = await session.client.createGroup(subject, participants, {
      description,
    });

    res.json({ success: true, result });
  } catch (error) {
    console.error('POST /groups error', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.patch('/groups/:id', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const groupId = req.params.id;
    const { subject, description } = req.body;
    const chat = await session.client.getChatById(groupId);
    if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Group not found' });

    const results = {};
    if (subject) {
      results.subject = await chat.setSubject(subject);
    }
    if (description && typeof chat.setDescription === 'function') {
      results.description = await chat.setDescription(description);
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('PATCH /groups/:id error', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

router.post('/groups/:id/participants', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const groupId = req.params.id;
    const { participants } = req.body;
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'participants array is required' });
    }

    const chat = await session.client.getChatById(groupId);
    if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Group not found' });

    const result = await chat.addParticipants(participants);
    res.json({ success: true, result });
  } catch (error) {
    console.error('POST /groups/:id/participants error', error);
    res.status(500).json({ error: 'Failed to add participants' });
  }
});

router.delete('/groups/:id/participants', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const groupId = req.params.id;
    const { participants } = req.body;
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'participants array is required' });
    }

    const chat = await session.client.getChatById(groupId);
    if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Group not found' });

    const result = await chat.removeParticipants(participants);
    res.json({ success: true, result });
  } catch (error) {
    console.error('DELETE /groups/:id/participants error', error);
    res.status(500).json({ error: 'Failed to remove participants' });
  }
});

export default router;
