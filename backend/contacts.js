import express from 'express';

const router = express.Router();

function normalizePhone(phone) {
  if (!phone) return phone;
  return String(phone).replace(/\D/g, '');
}

router.get('/contacts', async (req, res) => {
  try {
    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const contacts = await session.client.getContacts();
    const payload = contacts.map(contact => ({
      id: contact.id._serialized,
      number: contact.number,
      name: contact.name ?? null,
      pushname: contact.pushname ?? null,
      isMyContact: contact.isMyContact,
      isWAContact: contact.isWAContact,
    }));

    res.json({ contacts: payload });
  } catch (error) {
    console.error('GET /contacts error', error);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

router.post('/contacts/check', async (req, res) => {
  try {
    const { blocking, contacts } = req.body;
    if (!Array.isArray(contacts)) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    const session = req.sessionClient;
    if (!session) return res.status(404).json({ error: 'Session not initialized' });

    const results = await Promise.all(contacts.map(async (contact) => {
      const normalized = normalizePhone(contact);
      const exists = !!(await session.client.getNumberId(normalized));
      return { id: normalized, exists };
    }));

    res.json({ contacts: results });
  } catch (error) {
    console.error('POST /contacts/check error', error);
    res.status(500).json({ error: 'Failed to check contacts' });
  }
});

export default router;
