import express from 'express';
import whatsappWeb from 'whatsapp-web.js';

const { MessageMedia, Location, List, Buttons } = whatsappWeb;
const router = express.Router();

function normalizeJid(value) {
  if (!value) return value;
  const trimmed = String(value).trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits.endsWith('@c.us') || digits.endsWith('@g.us') ? digits : `${digits}@c.us`;
}

function createMessageOptions(type, body, filename) {
  const options = {};
  if (type === 'audio') {
    options.sendAudioAsVoice = true;
  }
  if (type === 'video') {
    options.sendVideoAsGif = false;
  }
  if (type === 'document') {
    options.sendMediaAsDocument = true;
    if (filename) options.filename = filename;
  }
  if (body) {
    options.caption = body;
  }
  return options;
}

router.post('/messages/text', async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to || !body) {
      return res.status(400).json({ error: 'to and body are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const message = await session.client.sendMessage(normalizeJid(to), body);
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/text error', error);
    res.status(500).json({ error: 'Failed to send text message' });
  }
});

router.post('/messages/image', async (req, res) => {
  try {
    const { to, media, caption } = req.body;
    if (!to || !media) {
      return res.status(400).json({ error: 'to and media are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const messageMedia = await MessageMedia.fromUrl(media);
    const message = await session.client.sendMessage(normalizeJid(to), messageMedia, createMessageOptions('image', caption));
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/image error', error);
    res.status(500).json({ error: 'Failed to send image message' });
  }
});

router.post('/messages/audio', async (req, res) => {
  try {
    const { to, media } = req.body;
    if (!to || !media) {
      return res.status(400).json({ error: 'to and media are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const messageMedia = await MessageMedia.fromUrl(media);
    const message = await session.client.sendMessage(normalizeJid(to), messageMedia, createMessageOptions('audio')); 
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/audio error', error);
    res.status(500).json({ error: 'Failed to send audio message' });
  }
});

router.post('/messages/video', async (req, res) => {
  try {
    const { to, media, caption } = req.body;
    if (!to || !media) {
      return res.status(400).json({ error: 'to and media are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const messageMedia = await MessageMedia.fromUrl(media);
    const message = await session.client.sendMessage(normalizeJid(to), messageMedia, createMessageOptions('video', caption));
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/video error', error);
    res.status(500).json({ error: 'Failed to send video message' });
  }
});

router.post('/messages/document', async (req, res) => {
  try {
    const { to, media, filename } = req.body;
    if (!to || !media) {
      return res.status(400).json({ error: 'to and media are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const messageMedia = await MessageMedia.fromUrl(media);
    const options = createMessageOptions('document', '', filename);
    const message = await session.client.sendMessage(normalizeJid(to), messageMedia, options);
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/document error', error);
    res.status(500).json({ error: 'Failed to send document message' });
  }
});

router.post('/messages/location', async (req, res) => {
  try {
    const { to, latitude, longitude, name, address, url } = req.body;
    if (!to || typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'to, latitude, and longitude are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const location = new Location(latitude, longitude, { name, address, url });
    const message = await session.client.sendMessage(normalizeJid(to), location);
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/location error', error);
    res.status(500).json({ error: 'Failed to send location message' });
  }
});

router.post('/messages/button', async (req, res) => {
  try {
    const { to, body, buttonText, buttons, title, footer } = req.body;
    if (!to || !body || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ error: 'to, body, and buttons are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const buttonPayload = new Buttons(body, buttons, title || null, footer || null);
    const message = await session.client.sendMessage(normalizeJid(to), buttonPayload);
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/button error', error);
    res.status(500).json({ error: 'Failed to send button message' });
  }
});

router.post('/messages/list', async (req, res) => {
  try {
    const { to, body, button, sections, title, footer } = req.body;
    if (!to || !body || !button || !Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ error: 'to, body, button, and sections are required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const listPayload = new List(body, button, sections, title || null, footer || null);
    const message = await session.client.sendMessage(normalizeJid(to), listPayload);
    res.json({ sent: { id: message.id._serialized, status: 'sent' } });
  } catch (error) {
    console.error('POST /messages/list error', error);
    res.status(500).json({ error: 'Failed to send list message' });
  }
});

router.delete('/messages/:id', async (req, res) => {
  try {
    const messageId = req.params.id;
    if (!messageId) {
      return res.status(400).json({ error: 'Message id is required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const message = await session.client.getMessageById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await message.delete(true);
    res.json({ deleted: true });
  } catch (error) {
    console.error('DELETE /messages/:id error', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export default router;
