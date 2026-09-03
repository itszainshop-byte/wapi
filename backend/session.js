import express from 'express';

const router = express.Router();

function getSessionInfoState(session) {
  if (!session) {
    return { status: 'disconnected', connected: false };
  }

  if (session.status === 'auth_failure') {
    return { status: 'auth_failure', connected: false };
  }

  if (session.client && session.connected && session.status === 'connected') {
    return { status: 'connected', connected: true };
  }

  if (session.status === 'qr') {
    return { status: 'qr', connected: false };
  }

  if (session.status === 'starting' || (session.client && !session.connected)) {
    return { status: 'starting', connected: false };
  }

  return { status: 'disconnected', connected: false };
}

router.get('/info', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) {
      return res.status(404).json({ error: 'Session not initialized' });
    }

    const state = getSessionInfoState(session);

    res.json({
      sessionId: session.sessionId,
      status: state.status,
      connected: state.connected,
      phone: session.phone ?? session.lastKnownPhone ?? null,
    });
  } catch (error) {
    console.error('GET /info error', error);
    res.status(500).json({ error: 'Failed to retrieve session info' });
  }
});

router.delete('/disconnect', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) {
      return res.status(404).json({ error: 'Session not initialized' });
    }

    await session.client.destroy();
    session.status = 'disconnected';
    session.connected = false;
    session.qr = null;

    res.json({ disconnected: true });
  } catch (error) {
    console.error('DELETE /disconnect error', error);
    res.status(500).json({ error: 'Failed to disconnect session' });
  }
});

export default router;
