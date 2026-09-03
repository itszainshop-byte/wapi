import express from 'express';

const router = express.Router();
let webhookConfig = {
  url: null,
  events: [],
};

router.get('/settings/webhooks', (req, res) => {
  res.json(webhookConfig);
});

router.put('/settings/webhooks', (req, res) => {
  const { url, events } = req.body;
  if (!url || !Array.isArray(events)) {
    return res.status(400).json({ error: 'url and events are required' });
  }

  webhookConfig = { url, events };
  res.json({ updated: true, url, events });
});

export default router;
