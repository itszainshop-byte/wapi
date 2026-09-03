import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, 'users.json');

async function ensureUsersFile() {
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, JSON.stringify([]), 'utf8');
  }
}

async function readUsers() {
  await ensureUsersFile();
  const raw = await fs.readFile(USERS_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return ${salt}:${derived};
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash).split(':');
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return crypto.timingSafeEqual(derived, stored);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function findUserByEmail(email) {
  const users = await readUsers();
  return users.find(user => String(user.email).toLowerCase() === String(email).toLowerCase()) || null;
}

async function findUserByToken(token) {
  if (!token) return null;
  const users = await readUsers();
  return users.find(user => user.token === token) || null;
}

function safeUser(user) {
  const { passwordHash, token, ...rest } = user;
  return rest;
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await findUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    const passwordHash = hashPassword(String(password));
    const token = generateToken();
    const users = await readUsers();
    const newUser = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      name: name ? String(name).trim() : null,
      passwordHash,
      token,
      createdAt: new Date().toISOString(),
    };
    users.push(newUser);
    await writeUsers(users);
    res.status(201).json({ user: safeUser(newUser), token });
  } catch (error) {
    console.error('POST /register error', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await findUserByEmail(String(email).trim().toLowerCase());
    if (!user || !verifyPassword(String(password), String(user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken();
    const users = await readUsers();
    const updated = users.map(item => item.id === user.id ? { ...item, token } : item);
    await writeUsers(updated);

    const refreshedUser = await findUserByEmail(String(email).trim().toLowerCase());
    res.json({ user: safeUser(refreshedUser), token });
  } catch (error) {
    console.error('POST /login error', error);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const user = await findUserByToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ user: safeUser(user) });
  } catch (error) {
    console.error('GET /me error', error);
    res.status(500).json({ error: 'Failed to retrieve user profile' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const user = await findUserByToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const users = await readUsers();
    const updated = users.map(item => item.id === user.id ? { ...item, token: null } : item);
    await writeUsers(updated);
    res.json({ success: true });
  } catch (error) {
    console.error('POST /logout error', error);
    res.status(500).json({ error: 'Failed to log out' });
  }
});

export default router;
