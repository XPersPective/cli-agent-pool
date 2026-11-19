import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_CHATS = 80;
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_RECENT_FOLDERS = 16;
const MAX_CONTEXT_CHARS = 3200;

const sha = value => createHash('sha256').update(String(value)).digest('hex');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function emptyState() {
  return {
    version: 1,
    cookieKey: randomBytes(32).toString('hex'),
    devices: [],
    sharedFolders: [],
    favoriteFolders: [],
    recentFolders: [],
    chats: [],
  };
}

export function buildCompactPrompt(chat, userPrompt, includeContext = true) {
  const prompt = String(userPrompt || '').trim();
  if (!includeContext || !chat?.messages?.length) return prompt;
  const turns = [];
  let current = null;
  for (const msg of chat.messages) {
    if (msg.role === 'user') {
      if (current) turns.push(current);
      current = { user: String(msg.text || '').trim(), assistant: null };
    } else if (msg.role === 'assistant' && current) {
      const files = Array.isArray(msg.report?.files) && msg.report.files.length
        ? ` [Dosyalar: ${msg.report.files.slice(0, 8).map(f => f.path).join(', ')}]`
        : '';
      const summary = msg.report?.summary || msg.result || msg.text || '';
      const clean = String(summary).replace(/\s+/g, ' ').trim();
      if (clean) current.assistant = `${clean.slice(0, 620)}${files}`;
    }
  }
  if (current) turns.push(current);
  const recent = turns.filter(t => t.user && t.assistant).slice(-3);
  if (!recent.length) return prompt;

  const lines = ['[Önceki konuşma özeti — kısa bağlam]'];
  let used = lines[0].length;
  for (const turn of recent) {
    const u = turn.user.replace(/\s+/g, ' ').slice(0, 380);
    const a = turn.assistant.slice(0, 650);
    const block = `- Kullanıcı: ${u}\n  Yanıt: ${a}`;
    if (used + block.length + 2 > MAX_CONTEXT_CHARS) break;
    lines.push(block);
    used += block.length + 1;
  }
  if (lines.length === 1) return prompt;
  return `${lines.join('\n')}\n\n[Güncel istek]\n${prompt}`;
}

export class RemoteStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'remote-state.json');
    this.state = this.load();
  }

  load() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!existsSync(this.file)) {
      const initial = emptyState();
      this.writeState(initial);
      return initial;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      const base = emptyState();
      const cleanPaths = list => (Array.isArray(list) ? list : []).filter(p => typeof p === 'string' && p.trim() && p.trim() !== '[object Object]');
      const cleanChats = (Array.isArray(parsed.chats) ? parsed.chats : []).map(c => ({
        ...c,
        workspace: (typeof c?.workspace === 'string' && c.workspace.trim() !== '[object Object]') ? c.workspace.trim() : '',
      }));
      return {
        version: 1,
        cookieKey: typeof parsed.cookieKey === 'string' && parsed.cookieKey.length >= 32 ? parsed.cookieKey : base.cookieKey,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        sharedFolders: cleanPaths(parsed.sharedFolders),
        favoriteFolders: cleanPaths(parsed.favoriteFolders),
        recentFolders: cleanPaths(parsed.recentFolders),
        chats: cleanChats,
      };
    } catch {
      const fallback = emptyState();
      this.writeState(fallback);
      return fallback;
    }
  }

  writeState(state = this.state) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  signSession(deviceId, secret) {
    return createHmac('sha256', Buffer.from(this.state.cookieKey, 'hex'))
      .update(`${deviceId}:${secret}`)
      .digest('hex');
  }

  pairDevice(label = 'Cihaz') {
    const id = randomUUID();
    const secret = randomBytes(24).toString('hex');
    const now = new Date().toISOString();
    const cleanLabel = String(label || 'Cihaz').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Cihaz';
    this.state.devices.push({
      id,
      label: cleanLabel,
      secretHash: sha(secret),
      createdAt: now,
      lastSeenAt: now,
    });
    if (this.state.devices.length > 30) this.state.devices = this.state.devices.slice(-30);
    this.writeState();
    const cookieValue = `${id}.${secret}.${this.signSession(id, secret)}`;
    return { id, label: cleanLabel, cookieValue };
  }

  verifyCookie(cookieValue) {
    if (typeof cookieValue !== 'string') return null;
    const parts = cookieValue.split('.');
    if (parts.length !== 3) return null;
    const [id, secret, mac] = parts;
    const device = this.state.devices.find(d => d.id === id);
    if (!device) return null;
    if (!safeEqual(sha(secret), device.secretHash)) return null;
    if (!safeEqual(mac, this.signSession(id, secret))) return null;
    const now = Date.now();
    if (!device.lastSeenAt || now - Date.parse(device.lastSeenAt) > 60_000) {
      device.lastSeenAt = new Date(now).toISOString();
      this.writeState();
    }
    return { id: device.id, label: device.label, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt };
  }

  listDevices() {
    return this.state.devices.map(({ id, label, createdAt, lastSeenAt }) => ({ id, label, createdAt, lastSeenAt }));
  }

  revokeDevice(deviceId) {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter(d => d.id !== deviceId);
    if (this.state.devices.length !== before) {
      this.writeState();
      return true;
    }
    return false;
  }

  recordRecentFolder(folder) {
    if (typeof folder !== 'string' || !folder.trim()) return;
    const clean = folder.trim();
    this.state.recentFolders = [clean, ...this.state.recentFolders.filter(f => f !== clean)].slice(0, MAX_RECENT_FOLDERS);
    this.writeState();
  }

  toggleFavoriteFolder(folder) {
    const clean = String(folder || '').trim();
    if (!clean) return this.state.favoriteFolders;
    if (this.state.favoriteFolders.includes(clean)) {
      this.state.favoriteFolders = this.state.favoriteFolders.filter(f => f !== clean);
    } else {
      this.state.favoriteFolders = [clean, ...this.state.favoriteFolders].slice(0, 24);
    }
    this.writeState();
    return this.state.favoriteFolders;
  }

  addSharedFolder(folder) {
    const clean = String(folder || '').trim();
    if (!clean) return this.state.sharedFolders;
    if (!this.state.sharedFolders.includes(clean)) {
      this.state.sharedFolders = [clean, ...this.state.sharedFolders].slice(0, 32);
      this.writeState();
    }
    return this.state.sharedFolders;
  }

  removeSharedFolder(folder) {
    const clean = String(folder || '').trim();
    const before = this.state.sharedFolders.length;
    this.state.sharedFolders = this.state.sharedFolders.filter(f => f !== clean);
    if (this.state.sharedFolders.length !== before) this.writeState();
    return this.state.sharedFolders;
  }

  listChats() {
    return [...this.state.chats]
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .map(c => ({
        id: c.id,
        title: c.title,
        workspace: c.workspace || '',
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: (c.messages || []).length,
        lastMessage: (c.messages || []).at(-1)?.text?.slice(0, 100) || '',
      }));
  }

  getChat(chatId) {
    return this.state.chats.find(c => c.id === chatId) || null;
  }

  createChat({ title = 'Yeni sohbet', workspace = '' } = {}) {
    const now = new Date().toISOString();
    const chat = {
      id: randomUUID(),
      title: String(title || 'Yeni sohbet').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Yeni sohbet',
      workspace: String(workspace || '').trim(),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.state.chats.unshift(chat);
    if (this.state.chats.length > MAX_CHATS) this.state.chats = this.state.chats.slice(0, MAX_CHATS);
    if (chat.workspace) this.recordRecentFolder(chat.workspace);
    else this.writeState();
    return chat;
  }

  updateChat(chatId, patch = {}) {
    const chat = this.getChat(chatId);
    if (!chat) return null;
    if (typeof patch.title === 'string' && patch.title.trim()) {
      chat.title = patch.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    }
    if (typeof patch.workspace === 'string') {
      chat.workspace = patch.workspace.trim();
      if (chat.workspace) this.recordRecentFolder(chat.workspace);
    }
    chat.updatedAt = new Date().toISOString();
    this.writeState();
    return chat;
  }

  deleteChat(chatId) {
    const before = this.state.chats.length;
    this.state.chats = this.state.chats.filter(c => c.id !== chatId);
    if (this.state.chats.length !== before) {
      this.writeState();
      return true;
    }
    return false;
  }

  appendMessage(chatId, message) {
    const chat = this.getChat(chatId);
    if (!chat) return null;
    const now = new Date().toISOString();
    const entry = { id: randomUUID(), createdAt: now, ...message };
    chat.messages.push(entry);
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages = chat.messages.slice(-MAX_MESSAGES_PER_CHAT);
    if (chat.messages.length === 1 && entry.role === 'user' && chat.title === 'Yeni sohbet') {
      chat.title = String(entry.text || 'Yeni sohbet').replace(/\s+/g, ' ').trim().slice(0, 52) || 'Yeni sohbet';
    }
    chat.updatedAt = now;
    this.writeState();
    return entry;
  }

  updateTaskMessage(chatId, taskId, patch) {
    const chat = this.getChat(chatId);
    if (!chat) return null;
    const msg = chat.messages.find(m => m.taskId === taskId);
    if (!msg) return null;
    Object.assign(msg, patch);
    chat.updatedAt = new Date().toISOString();
    this.writeState();
    return msg;
  }
}
