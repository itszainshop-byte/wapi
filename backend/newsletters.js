import express from 'express';

const router = express.Router();

function normalizeJid(value) {
  if (!value) return value;
  const trimmed = String(value).trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits.endsWith('@c.us') || digits.endsWith('@g.us') ? digits : `${digits}@c.us`;
}

router.get('/newsletters', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const channels = await session.client.getChannels();
    const payload = channels.map(channel => ({
      id: channel.id._serialized,
      name: channel.name,
      description: channel.description,
      isGroup: channel.isGroup,
    }));

    res.json({ newsletters: payload });
  } catch (error) {
    console.error('GET /newsletters error', error);
    res.status(500).json({ error: 'Failed to load newsletters' });
  }
});

router.post('/newsletters/:id/message', async (req, res) => {
  try {
    const newsletterId = req.params.id;
    const { body } = req.body;
    if (!newsletterId || !body) {
      return res.status(400).json({ error: 'id and body are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const message = await session.client.sendMessage(normalizeJid(newsletterId), body);
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /newsletters/:id/message error', error);
    res.status(500).json({ error: 'Failed to send newsletter message' });
  }
});

export default router;
