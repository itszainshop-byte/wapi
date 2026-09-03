import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import qrcode from 'qrcode';
import whatsappWeb from 'whatsapp-web.js';
import chatsRouter from './chats.js';
import groupsRouter from './groups.js';
import messagesRouter from './messages.js';
import contactsRouter from './contacts.js';
import newslettersRouter from './newsletters.js';
import statusesRouter from './statuses.js';
import webhooksRouter from './webhooks.js';
import sessionInfoRouter from './session.js';
import authRouter from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Client, LocalAuth } = whatsappWeb;
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DEFAULT_SESSION_ROOT = path.resolve(__dirname, '..', 'sessions');
const LEGACY_SESSION_ROOT = path.resolve(__dirname, 'sessions');
const SESSION_ROOT = process.env.SESSION_ROOT || DEFAULT_SESSION_ROOT;
const STARTING_TIMEOUT_MS = process.env.SESSION_STARTING_TIMEOUT_MS
  ? Number(process.env.SESSION_STARTING_TIMEOUT_MS)
  : 120000;
const STARTING_STALL_RECOVERY_MS = process.env.SESSION_STARTING_STALL_RECOVERY_MS
  ? Number(process.env.SESSION_STARTING_STALL_RECOVERY_MS)
  : 25000;
const SESSION_CLIENT_INITIALIZE_TIMEOUT_MS = process.env.SESSION_CLIENT_INITIALIZE_TIMEOUT_MS
  ? Number(process.env.SESSION_CLIENT_INITIALIZE_TIMEOUT_MS)
  : 90000;
const SESSION_RECOVERY_COOLDOWN_MS = process.env.SESSION_RECOVERY_COOLDOWN_MS
  ? Number(process.env.SESSION_RECOVERY_COOLDOWN_MS)
  : 30000;
const SESSION_AUTO_RECOVER_DELAY_MS = process.env.SESSION_AUTO_RECOVER_DELAY_MS
  ? Number(process.env.SESSION_AUTO_RECOVER_DELAY_MS)
  : 5000;
const SESSION_RECOVER_CALL_TIMEOUT_MS = process.env.SESSION_RECOVER_CALL_TIMEOUT_MS
  ? Number(process.env.SESSION_RECOVER_CALL_TIMEOUT_MS)
  : 15000;
const SESSION_MAX_RECOVERY_COOLDOWN_MS = process.env.SESSION_MAX_RECOVERY_COOLDOWN_MS
  ? Number(process.env.SESSION_MAX_RECOVERY_COOLDOWN_MS)
  : 10 * 60000;
const SESSION_MAX_CONSECUTIVE_RECOVERY_TIMEOUTS = process.env.SESSION_MAX_CONSECUTIVE_RECOVERY_TIMEOUTS
  ? Number(process.env.SESSION_MAX_CONSECUTIVE_RECOVERY_TIMEOUTS)
  : 5;
const CLIENT_DESTROY_TIMEOUT_MS = process.env.SESSION_CLIENT_DESTROY_TIMEOUT_MS
  ? Number(process.env.SESSION_CLIENT_DESTROY_TIMEOUT_MS)
  : 8000;
const MAX_CONCURRENT_SESSION_STARTUPS = process.env.MAX_CONCURRENT_SESSION_STARTUPS
  ? Number(process.env.MAX_CONCURRENT_SESSION_STARTUPS)
  : 1;
const GET_CHATS_CONCURRENCY = process.env.SESSION_GET_CHATS_CONCURRENCY
  ? Number(process.env.SESSION_GET_CHATS_CONCURRENCY)
  : 12;
const EXPLICIT_START_MIN_INTERVAL_MS = process.env.SESSION_EXPLICIT_START_MIN_INTERVAL_MS
  ? Number(process.env.SESSION_EXPLICIT_START_MIN_INTERVAL_MS)
  : 10000;
const SESSION_IDLE_RECOVERY_SUPPRESS_MS = process.env.SESSION_IDLE_RECOVERY_SUPPRESS_MS
  ? Number(process.env.SESSION_IDLE_RECOVERY_SUPPRESS_MS)
  : 60000;
const STALE_BROWSER_ARTIFACTS = ['DevToolsActivePort', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
const BROWSER_LOCK_RELEASE_TIMEOUT_MS = 15000;
const BROWSER_LOCK_RETRY_MS = 250;
const SESSION_PROFILE_LOCK_COOLDOWN_MS = process.env.SESSION_PROFILE_LOCK_COOLDOWN_MS
  ? Number(process.env.SESSION_PROFILE_LOCK_COOLDOWN_MS)
  : 120000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const DETACHED_FRAME_ERROR = /detached frame|Navigating frame was detached|LifecycleWatcher disposed|Target page, context or browser has been closed|Target closed|Execution context was destroyed|Session closed/i;
const LOCKFILE_BUSY_ERROR = /EBUSY|resource busy or locked|lockfile|already running for/i;
const TRANSIENT_INIT_ERROR = /Runtime\.callFunctionOn|Target closed|Execution context was destroyed|Timed out after .*WS endpoint URL|The browser is already running for .*session/i;
const ALREADY_RUNNING_ERROR = /The browser is already running for .*session|already running for/i;

const app = express();

// ============================================================
// HEALTH CHECK - MUST BE DEFINED FIRST
// ============================================================
app.get('/healthz', (_req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
// ============================================================

const sessions = new Map();
const sessionInitPromises = new Map();
const sessionStartupQueue = [];
let activeSessionStartups = 0;

// Diagnostic logging for container environment
console.log('=== WhatsApp Server Startup ===');
console.log('Node version:', process.version);
console.log('Running as root:', process.getuid ? process.getuid() === 0 : 'unknown');
console.log('Platform:', process.platform);
console.log('PORT:', PORT);
console.log('SESSION_ROOT:', SESSION_ROOT);
console.log('================================');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withSessionStartupSlot(task) {
  if (activeSessionStartups >= MAX_CONCURRENT_SESSION_STARTUPS) {
    await new Promise((resolve) => {
      sessionStartupQueue.push(resolve);
    });
  }

  activeSessionStartups += 1;
  try {
    return await task();
  } finally {
    activeSessionStartups = Math.max(0, activeSessionStartups - 1);
    const next = sessionStartupQueue.shift();
    if (next) {
      next();
    }
  }
}

function uniqueRoots(roots) {
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function resolveSessionDir(sessionId) {
  const roots = process.env.SESSION_ROOT
    ? uniqueRoots([SESSION_ROOT])
    : uniqueRoots([SESSION_ROOT, LEGACY_SESSION_ROOT]);

  for (const root of roots) {
    const candidate = path.join(root, sessionId);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next location.
    }
  }

  return path.join(SESSION_ROOT, sessionId);
}

function isRecoverableRuntimeError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  const combined = `${name}: ${message}`;

  if (error?.code === 'SESSION_INITIALIZE_TIMEOUT') return true;

  if (DETACHED_FRAME_ERROR.test(combined)) return true;
  if (LOCKFILE_BUSY_ERROR.test(combined)) return true;
  if (TRANSIENT_INIT_ERROR.test(combined)) return true;
  if (message.trim().toLowerCase() === 'r') return true;
  if (/^r\s*:\s*r$/i.test(combined.trim())) return true;
  return false;
}

function shouldRetryRecoverableError(error) {
  const message = String(error?.message || '');

  if (error?.code === 'SESSION_INITIALIZE_TIMEOUT') {
    return false;
  }

  // If another chromium instance still owns userDataDir, immediate retry is almost always futile.
  if (ALREADY_RUNNING_ERROR.test(message)) {
    return false;
  }

  return true;
}

function isSessionProfileLockError(error) {
  if (!error) {
    return false;
  }

  if (error?.code === 'SESSION_PROFILE_LOCKED') {
    return true;
  }

  const message = String(error?.message || '');
  return /session profile lock|already running for/i.test(message);
}

function createInitializeTimeoutError(sessionId) {
  const error = new Error(`Session ${sessionId} initialize timed out after ${SESSION_CLIENT_INITIALIZE_TIMEOUT_MS}ms`);
  error.code = 'SESSION_INITIALIZE_TIMEOUT';
  return error;
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error(message), { code: 'SESSION_RECOVERY_TIMEOUT' })), timeoutMs);
    }),
  ]);
}

// Windows doesn't cascade-kill a Chromium process tree on plain process.kill(),
// leaving orphaned renderer/GPU child processes behind; taskkill /T does.
function forceKillProcessTree(pid) {
  if (!pid) {
    return;
  }

  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
    // Ignore failures: the process may already be gone.
  });
}

async function destroyClientSafely(client, reason = 'unknown') {
  if (!client) {
    return;
  }

  const browserProcess = typeof client.pupBrowser?.process === 'function' ? client.pupBrowser.process() : null;

  try {
    await withTimeout(Promise.resolve(client.destroy()), CLIENT_DESTROY_TIMEOUT_MS, `Client destroy timed out (${reason})`);
  } catch (error) {
    console.warn('Client destroy did not complete cleanly; force-killing browser process', reason, error?.message || error);
  }

  if (browserProcess?.pid && browserProcess.exitCode === null && !browserProcess.killed) {
    forceKillProcessTree(browserProcess.pid);
  }
}

// Repeated init/recovery timeouts grow the cooldown and eventually stop
// auto-retrying so a chronically broken session can't spam launches forever.
function applyRecoveryTimeoutBackoff(session, reason = 'unknown') {
  session.consecutiveRecoveryTimeouts = Number(session.consecutiveRecoveryTimeouts || 0) + 1;
  const attempt = session.consecutiveRecoveryTimeouts;
  const cooldownMs = Math.min(SESSION_RECOVERY_COOLDOWN_MS * (2 ** (attempt - 1)), SESSION_MAX_RECOVERY_COOLDOWN_MS);
  session.recoveryBlockedUntil = Date.now() + cooldownMs;

  if (attempt >= SESSION_MAX_CONSECUTIVE_RECOVERY_TIMEOUTS) {
    session.recoveryPaused = true;
    console.warn(
      `Session ${session.sessionId} hit ${attempt} consecutive recovery timeouts (${reason}); pausing auto-recovery until explicit /start`,
    );
    return false;
  }

  console.warn(
    `Session ${session.sessionId} recovery timed out (${reason}); backing off ${Math.round(cooldownMs / 1000)}s (attempt ${attempt}/${SESSION_MAX_CONSECUTIVE_RECOVERY_TIMEOUTS})`,
  );
  return true;
}

function isTimeoutRecoveryError(error) {
  return error?.code === 'SESSION_INITIALIZE_TIMEOUT' || error?.code === 'SESSION_RECOVERY_TIMEOUT';
}

function markSessionDisconnected(session, client, { preservePhone = true } = {}) {
  // Ignore stale client events from a previous client instance.
  if (client && session.client && session.client !== client) {
    return;
  }

  session.status = 'disconnected';
  session.connected = false;
  session.qr = null;
  if (!preservePhone) {
    session.phone = null;
  }
  if (!client || session.client === client) {
    session.client = null;
  }
  if (session.startingTimeoutHandle) {
    clearTimeout(session.startingTimeoutHandle);
    session.startingTimeoutHandle = null;
  }
  session.startingSince = 0;
}

function markSessionAuthFailure(session, client) {
  if (client && session.client && session.client !== client) {
    return;
  }

  session.status = 'auth_failure';
  session.connected = false;
  session.qr = null;
  session.phone = null;
  if (!client || session.client === client) {
    session.client = null;
  }
  if (session.startingTimeoutHandle) {
    clearTimeout(session.startingTimeoutHandle);
    session.startingTimeoutHandle = null;
  }
  session.startingSince = 0;
}

function clearSessionRecoveryTimer(session) {
  if (session?.recoveryTimerHandle) {
    clearTimeout(session.recoveryTimerHandle);
    session.recoveryTimerHandle = null;
  }
}

function scheduleSessionRecovery(session, reason = 'unknown') {
  if (!session) {
    return;
  }

  if (session.status === 'auth_failure') {
    return;
  }

  if (session.recoveryTimerHandle) {
    return;
  }

  const blockedFor = Math.max(0, Number(session.recoveryBlockedUntil || 0) - Date.now());
  const waitMs = Math.max(SESSION_AUTO_RECOVER_DELAY_MS, blockedFor + 50);

  session.recoveryTimerHandle = setTimeout(async () => {
    session.recoveryTimerHandle = null;

    if (session.status !== 'disconnected') {
      return;
    }

    if (typeof session.recoverClient !== 'function') {
      return;
    }

    // Nobody has looked at this session recently (no /info, /qr, /start, or data
    // request) — don't spend a browser launch keeping it warm in the background.
    // It resumes normally the moment a real request touches it again.
    const idleFor = Date.now() - Number(session.lastAccessedAt || 0);
    if (idleFor > SESSION_IDLE_RECOVERY_SUPPRESS_MS) {
      return;
    }

    if (session.recoveryBlockedUntil && session.recoveryBlockedUntil > Date.now()) {
      if (!session.recoveryPaused) {
        scheduleSessionRecovery(session, 'cooldown');
      }
      return;
    }

    try {
      await session.recoverClient();
      reconcileSessionConnectedState(session);
      enforceStartingTimeoutFallback(session);

      if (session.status === 'disconnected' && !session.recoveryPaused) {
        scheduleSessionRecovery(session, 'still_disconnected');
      }
    } catch (error) {
      if (isTimeoutRecoveryError(error)) {
        console.warn('Background session recovery timeout, waiting for explicit /start', session.sessionId, error?.message || error);
        if (!session.recoveryPaused) {
          scheduleSessionRecovery(session, 'timeout_backoff');
        }
        return;
      }

      if (isRecoverableRuntimeError(error)) {
        if (!shouldRetryRecoverableError(error) || isSessionProfileLockError(error)) {
          console.warn('Background session recovery paused due to profile lock; waiting for explicit /start', session.sessionId, error?.message || error);
          session.recoveryBlockedUntil = Date.now() + SESSION_PROFILE_LOCK_COOLDOWN_MS;
          return;
        }

        console.warn('Background session recovery failed, will retry', session.sessionId, reason, error?.message || error);
        scheduleSessionRecovery(session, 'recoverable_error');
        return;
      }

      console.error('Background session recovery aborted', session.sessionId, error);
    }
  }, waitMs);
}

function shouldReinitializeSession(session) {
  if (!session) {
    return true;
  }

  return session.status === 'disconnected' || session.status === 'auth_failure';
}

function enforceStartingTimeoutFallback(session) {
  if (!session || session.status !== 'starting') {
    return;
  }

  const startingSince = Number(session.startingSince || 0);
  if (!startingSince) {
    return;
  }

  if (Date.now() - startingSince <= STARTING_TIMEOUT_MS + 3000) {
    return;
  }

  const client = session.client;
  console.warn(`Session ${session.sessionId} exceeded starting fallback window; forcing disconnect state`);
  markSessionDisconnected(session, client, { preservePhone: false });
  session.recoveryBlockedUntil = Date.now() + SESSION_RECOVERY_COOLDOWN_MS;

  destroyClientSafely(client, 'starting_fallback_timeout').catch((error) => {
    console.warn('Failed to destroy fallback-disconnected client', error);
  });
}

function isSessionStartupStalled(session) {
  if (!session || session.status !== 'starting') {
    return false;
  }

  const startingSince = Number(session.startingSince || 0);
  if (!startingSince) {
    return false;
  }

  return Date.now() - startingSince > STARTING_STALL_RECOVERY_MS;
}

function reconcileSessionConnectedState(session) {
  if (!session) {
    return session;
  }

  // Connected status without an active client is inconsistent and should be reset.
  if (!session.client) {
    if (session.status === 'starting') {
      const startedAt = Number(session.startingSince || 0);
      const startingTooLong = startedAt && (Date.now() - startedAt > STARTING_TIMEOUT_MS + 3000);
      if (!startedAt || startingTooLong) {
        session.status = 'disconnected';
        session.connected = false;
        session.qr = null;
      }
    }

    if (session.status === 'connected' || session.connected) {
      session.status = 'disconnected';
      session.connected = false;
      session.qr = null;
    }
    return session;
  }

  const phone = session.client.info?.me?.user ?? session.client.info?.wid?.user ?? null;
  if (!phone) {
    return session;
  }

  session.status = 'connected';
  session.connected = true;
  session.qr = null;
  session.phone = phone;
  session.lastKnownPhone = phone;
  session.consecutiveRecoveryTimeouts = 0;
  clearSessionRecoveryTimer(session);
  if (session.startingTimeoutHandle) {
    clearTimeout(session.startingTimeoutHandle);
    session.startingTimeoutHandle = null;
  }
  session.startingSince = 0;

  return session;
}

async function initializeClientWithTimeout(client, sessionId) {
  let timeoutHandle = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(createInitializeTimeoutError(sessionId));
    }, SESSION_CLIENT_INITIALIZE_TIMEOUT_MS);
  });

  try {
    await Promise.race([client.initialize(), timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function createTimeoutError(message, code = 'SESSION_RECOVERY_TIMEOUT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function abortTimedOutSessionRecovery(session, reason = 'unknown') {
  if (!session) {
    return;
  }

  const activeClient = session.client;
  markSessionDisconnected(session, activeClient, { preservePhone: true });

  await destroyClientSafely(activeClient, reason);

  // Release the in-flight recovery gate so a fresh recovery attempt can start.
  session.recoveringPromise = null;
}

async function recoverClientWithTimeout(session, reason = 'unknown') {
  if (!session || typeof session.recoverClient !== 'function') {
    return null;
  }

  // Concurrent callers (e.g. rapid frontend polling) must share one in-flight
  // race, otherwise each independently times out against the same stuck attempt
  // and inflates the backoff counter/log spam N times over.
  if (session.recoverWithTimeoutPromise) {
    return session.recoverWithTimeoutPromise;
  }

  const recoveryPromise = Promise.resolve(session.recoverClient());

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(createTimeoutError(`Session recovery timed out (${reason})`));
    }, SESSION_RECOVER_CALL_TIMEOUT_MS);
  });

  const racePromise = Promise.race([recoveryPromise, timeoutPromise])
    .catch(async (error) => {
      if (error?.code === 'SESSION_RECOVERY_TIMEOUT') {
        // Ensure the timed-out promise does not surface as an unhandled rejection later.
        recoveryPromise.catch((lateError) => {
          console.warn('Late recovery completion after timeout', session.sessionId, reason, lateError?.message || lateError);
        });
        applyRecoveryTimeoutBackoff(session, reason);
        await abortTimedOutSessionRecovery(session, reason);
      }

      throw error;
    })
    .finally(() => {
      if (session.recoverWithTimeoutPromise === racePromise) {
        session.recoverWithTimeoutPromise = null;
      }
    });

  session.recoverWithTimeoutPromise = racePromise;
  return racePromise;
}

function triggerSessionRecovery(session, reason = 'unknown') {
  if (!session || typeof session.recoverClient !== 'function') {
    return;
  }

  recoverClientWithTimeout(session, reason).catch((error) => {
    if (error?.code === 'SESSION_RECOVERY_TIMEOUT') {
      console.warn('Timed out recovering session in background', session.sessionId, reason);
      return;
    }

    if (isRecoverableRuntimeError(error)) {
      if (!shouldRetryRecoverableError(error) || isSessionProfileLockError(error)) {
        console.warn('Recoverable background recovery paused due to profile lock', session.sessionId, error?.message || error);
        session.recoveryBlockedUntil = Date.now() + SESSION_PROFILE_LOCK_COOLDOWN_MS;
        return;
      }

      console.warn('Recoverable background recovery failure', session.sessionId, error?.message || error);
      scheduleSessionRecovery(session, 'background_recoverable_error');
      return;
    }

    console.error('Background recovery failed', session.sessionId, error);
  });
}

async function maybeRecoverSession(session) {
  if (!session || session.status !== 'disconnected') {
    return session;
  }

  if (typeof session.recoverClient !== 'function') {
    return session;
  }

  if (session.recoveryBlockedUntil && session.recoveryBlockedUntil > Date.now()) {
    return session;
  }

  try {
    await recoverClientWithTimeout(session, 'maybe_recover_session');
  } catch (error) {
    if (isRecoverableRuntimeError(error)) {
      if (!shouldRetryRecoverableError(error) || isSessionProfileLockError(error)) {
        console.warn('Recoverable session recovery paused due to profile lock', session.sessionId, error?.message || error);
        session.recoveryBlockedUntil = Date.now() + SESSION_PROFILE_LOCK_COOLDOWN_MS;
        return session;
      }

      console.warn('Recoverable session recovery failure', session.sessionId, error?.message || error);
      scheduleSessionRecovery(session, 'recoverable_maybe_recover_failure');
      return session;
    }

    if (error?.code === 'SESSION_RECOVERY_TIMEOUT') {
      console.warn('Session recovery timed out', session.sessionId, error?.message || error);
      if (!session.recoveryPaused) {
        scheduleSessionRecovery(session, 'maybe_recover_timeout');
      }
      return session;
    }
    throw error;
  }

  return session;
}

async function clearStaleBrowserArtifacts(sessionDir) {
  const browserSessionDir = path.join(sessionDir, 'session');

  for (const fileName of STALE_BROWSER_ARTIFACTS) {
    const artifactPath = path.join(browserSessionDir, fileName);
    const startedAt = Date.now();

    while (true) {
      try {
        await fs.rm(artifactPath, { force: true });
        break;
      } catch (error) {
        const isBrowserLock = fileName === 'lockfile' || fileName.startsWith('Singleton');
        const timedOut = Date.now() - startedAt >= BROWSER_LOCK_RELEASE_TIMEOUT_MS;
        if (!isBrowserLock || !LOCKFILE_BUSY_ERROR.test(String(error?.message || '')) || timedOut) {
          if (isBrowserLock && timedOut) {
            const profileLockError = new Error(`Chromium still holds the session profile lock: ${artifactPath}`);
            profileLockError.code = 'SESSION_PROFILE_LOCKED';
            throw profileLockError;
          }
          break;
        }

        await sleep(BROWSER_LOCK_RETRY_MS);
      }
    }
  }
}

// window.WWebJS.getChats() builds every chat model with Promise.all, so a single
// chat/group with unreadable metadata (e.g. broken group/newsletter state) throws
// and takes down the whole list. Patch it in-page to skip broken chats instead.
async function patchResilientGetChats(client) {
  await client.pupPage.evaluate((concurrency) => {
    if (window.WWebJS?.__resilientGetChats) {
      return;
    }

    const originalGetChatModel = window.WWebJS.getChatModel;

    // A group whose metadata subquery fails should still show up with its basic
    // fields (empty participants) instead of disappearing or crashing chat.participants.
    window.WWebJS.getChatModel = async (chat, options = {}) => {
      try {
        return await originalGetChatModel(chat, options);
      } catch (error) {
        if (!chat?.groupMetadata) {
          throw error;
        }

        const model = chat.serialize();
        model.isGroup = true;
        model.formattedTitle = chat.formattedTitle;
        model.groupMetadata = { participants: [] };
        return model;
      }
    };

    // Building the real model per chat calls groupMetadata.update(), a network
    // round-trip per group; on accounts with tens of thousands of chats/groups
    // this makes bulk listing take minutes. The bulk list only needs already
    // -synced local Store data (no network calls), so build it separately from
    // the single-chat lookup path (which still fetches fresh metadata via
    // window.WWebJS.getChatModel above).
    function buildListChatModel(chat) {
      const model = chat.serialize();
      model.isGroup = false;
      model.isMuted = chat.mute?.expiration !== 0;
      model.formattedTitle = chat.formattedTitle;

      if (chat.groupMetadata) {
        model.isGroup = true;
        const { toPn } = window.require('WAWebLidMigrationUtils');
        const serializedMetadata = chat.groupMetadata.serialize();
        for (const p of serializedMetadata.participants || []) {
          p.id = toPn(p.id) ?? p.id;
        }
        model.groupMetadata = serializedMetadata;
        model.isReadOnly = chat.groupMetadata.announce;
      }

      model.lastMessage = null;
      if (model.msgs && model.msgs.length && chat.lastReceivedKey) {
        const lastMessage = window.require('WAWebCollections').Msg.get(chat.lastReceivedKey._serialized);
        if (lastMessage) {
          model.lastMessage = window.WWebJS.getMessageModel(lastMessage);
        }
      }

      delete model.msgs;
      delete model.msgUnsyncedButtonReplyMsgs;
      delete model.unsyncedButtonReplies;

      return model;
    }

    // Run a bounded worker pool instead of a sequential loop or an unbounded Promise.all
    // so message-cache lookups for many chats aren't serialized either.
    window.WWebJS.getChats = async () => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      const results = new Array(chats.length);
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < chats.length) {
          const current = nextIndex++;
          try {
            results[current] = buildListChatModel(chats[current]);
          } catch (error) {
            // Skip chats whose local model can't be built at all.
          }
        }
      }

      const workerCount = Math.max(1, Math.min(concurrency, chats.length));
      await Promise.all(Array.from({ length: workerCount }, worker));
      return results.filter(Boolean);
    };
    window.WWebJS.__resilientGetChats = true;
  }, GET_CHATS_CONCURRENCY);
}

function createClient(sessionDir) {
  return new Client({
    authStrategy: new LocalAuth({ dataPath: sessionDir }),
    userAgent: process.env.WHATSAPP_USER_AGENT || DEFAULT_USER_AGENT,
    // Avoid whatsapp-web.js's bundled pinned WhatsApp Web version going stale and breaking
    // internal module lookups (e.g. WAWebCollections) after WhatsApp ships updates.
    webVersionCache: { type: 'none' },
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-crash-reporter',
        '--disable-domain-reliability',
        '--disable-print-preview',
        '--disable-features=AudioServiceOutOfProcess',
        '--disable-features=NetworkService',
        '--disable-features=OutOfBlinkCors',
        '--disable-javascript',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-first-run',
        '--no-pings',
        '--no-zygote',
        '--single-process',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-databases',
        '--disable-file-system',
        '--disable-translate',
        '--disable-web-security',
        '--enable-automation',
        '--force-device-scale-factor=1',
        '--remote-debugging-port=0',
      ],
    },
  });
}

function attachSessionHandlers(session, client) {
  const clearStartingTimeout = () => {
    if (session.startingTimeoutHandle) {
      clearTimeout(session.startingTimeoutHandle);
      session.startingTimeoutHandle = null;
    }
    session.startingSince = 0;
  };

  client.on('qr', (qr) => {
    if (session.client !== client) {
      return;
    }

    clearStartingTimeout();
    session.status = 'qr';
    session.qr = qr;
    session.connected = false;
    session.phone = session.phone ?? session.lastKnownPhone ?? null;
  });

  client.on('ready', () => {
    if (session.client !== client) {
      return;
    }

    clearSessionRecoveryTimer(session);
    clearStartingTimeout();
    session.status = 'connected';
    session.connected = true;
    session.qr = null;
    session.phone = client.info?.me?.user ?? client.info?.wid?.user ?? null;
    session.lastKnownPhone = session.phone;
    session.consecutiveRecoveryTimeouts = 0;
    session.chatsCache = null;
    session.chatsCachePromise = null;

    patchResilientGetChats(client).catch((error) => {
      console.warn('Failed to patch resilient getChats for session', session.sessionId, error?.message || error);
    });
  });

  client.on('authenticated', () => {
    if (session.client !== client) {
      return;
    }

    // Some clients emit authenticated before ready; if account info is available,
    // promote state so /info does not remain in starting.
    reconcileSessionConnectedState(session);
  });

  client.on('auth_failure', (message) => {
    if (session.client !== client) {
      return;
    }

    clearSessionRecoveryTimer(session);
    clearStartingTimeout();
    console.error('WhatsApp auth failure', message);
    session.status = 'auth_failure';
    session.connected = false;
    session.qr = null;
  });

  client.on('disconnected', async (reason) => {
    if (session.client !== client) {
      return;
    }

    clearStartingTimeout();
    console.warn('WhatsApp client disconnected', reason);
    const normalizedReason = String(reason || '').toLowerCase();
    const isLogout = normalizedReason.includes('logout');

    if (isLogout) {
      markSessionAuthFailure(session, client);
    } else {
      markSessionDisconnected(session, client);
    }

    await destroyClientSafely(client, 'disconnected_event');

    if (!isLogout) {
      scheduleSessionRecovery(session, String(reason || 'disconnected_event'));
    }
  });
}

async function initializeSessionClient(session, sessionId, sessionDir) {
  await clearStaleBrowserArtifacts(sessionDir);

  const client = createClient(sessionDir);
  attachSessionHandlers(session, client);
  session.client = client;

  if (session.startingTimeoutHandle) {
    clearTimeout(session.startingTimeoutHandle);
    session.startingTimeoutHandle = null;
  }

  session.status = 'starting';
  session.qr = null;
  session.connected = false;
  session.phone = session.phone ?? session.lastKnownPhone ?? null;
  session.startingSince = Date.now();
  session.recoveryBlockedUntil = 0;

  session.startingTimeoutHandle = setTimeout(async () => {
    if (session.status !== 'starting') {
      return;
    }

    console.warn(`Session ${sessionId} stayed in starting longer than ${STARTING_TIMEOUT_MS}ms`);
    markSessionDisconnected(session, client, { preservePhone: false });
    applyRecoveryTimeoutBackoff(session, 'starting_timeout');

    await destroyClientSafely(client, 'starting_timeout');
  }, STARTING_TIMEOUT_MS);

  session.recoverClient = async () => {
    if (session.recoveringPromise) {
      return session.recoveringPromise;
    }

    if (session.recoveryBlockedUntil && session.recoveryBlockedUntil > Date.now()) {
      return null;
    }

    session.recoveringPromise = (async () => {
      await destroyClientSafely(session.client, 'before_recovery');

      try {
        await withSessionStartupSlot(() => initializeSessionClient(session, sessionId, sessionDir));
        return session.client;
      } catch (error) {
        markSessionDisconnected(session, null, { preservePhone: false });

        if (error?.code === 'SESSION_INITIALIZE_TIMEOUT') {
          applyRecoveryTimeoutBackoff(session, 'recover_initialize_timeout');
          console.warn('Recovery initialize timeout for session, waiting for explicit start', sessionId);
          return null;
        }

        session.recoveryBlockedUntil = Date.now() + SESSION_RECOVERY_COOLDOWN_MS;

        if (isSessionProfileLockError(error
