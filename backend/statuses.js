import express from 'express';

const router = express.Router();

router.post('/statuses', async (req, res) => {
  try {
    const { body } = req.body;
    if (!body) {
      return res.status(400).json({ error: 'body is required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    await session.client.setStatus(body);
    res.json({ sent: { status: 'updated' } });
  } catch (error) {
    console.error('POST /statuses error', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

router.get('/statuses', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const contacts = await session.client.getContacts();
    const statuses = await Promise.all(contacts.map(async contact => {
      try {
        const broadcast = await contact.getBroadcast();
        return {
          id: contact.id._serialized,
          from: contact.number,
          name: contact.name ?? contact.pushname ?? null,
          status: broadcast?.body ?? null,
          timestamp: broadcast?.t ?? null,
        };
      } catch {
        return null;
      }
    }));

    res.json({ statuses: statuses.filter(Boolean) });
  } catch (error) {
    console.error('GET /statuses error', error);
    res.status(500).json({ error: 'Failed to load statuses' });
  }
});

export default router;
