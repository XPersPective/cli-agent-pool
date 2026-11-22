import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const MAX_CHATS = 80;
const MAX_MESSAGES_PER_CHAT = 200;
const MAX_RECENT_FOLDERS = 16;
const MAX_CONTEXT_CHARS = 3200;
const DEVICE_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

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
      const filePaths = Array.isArray(msg.report?.files)
        ? msg.report.files.slice(0, 8).map(f => (typeof f === 'string' ? f : f?.path)).filter(Boolean)
        : [];
      const files = filePaths.length ? ` [Dosyalar: ${filePaths.join(', ')}]` : '';
      const summary = msg.report?.summary || msg.result || msg.text || '';
      const clean = String(summary).replace(/\s+/g, ' ').trim();
      if (clean) current.assistant = { text: clean.slice(0, 620), files: files.slice(0, 260) };
    }
  }
  if (current) turns.push(current);
  const recent = turns.filter(t => t.user && t.assistant).slice(-3);
  if (!recent.length) return prompt;

  const header = '[Önceki konuşma özeti — kısa bağlam]';
  let used = header.length;
  const blocks = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i];
    const u = turn.user.replace(/\s+/g, ' ').slice(0, 380);
    const a = `${turn.assistant.text}${turn.assistant.files}`;
    const block = `- Kullanıcı: ${u}\n  Yanıt: ${a}`;
    if (used + block.length + 2 > MAX_CONTEXT_CHARS) break;
    blocks.unshift(block);
    used += block.length + 1;
  }
  if (!blocks.length) return prompt;
  return `${header}\n${blocks.join('\n')}\n\n[Güncel istek]\n${prompt}`;
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
      const cleanSession = s => (s && typeof s === 'object' && typeof s.sessionId === 'string' && s.sessionId.trim()
        ? {
            sessionId: s.sessionId.trim(),
            routeId: typeof s.routeId === 'string' ? s.routeId : '',
            modelId: typeof s.modelId === 'string' ? s.modelId : '',
            adapter: typeof s.adapter === 'string' ? s.adapter : '',
            group: typeof s.group === 'string' ? s.group : '',
            workspace: (typeof s.workspace === 'string' && s.workspace.trim() !== '[object Object]') ? s.workspace.trim() : '',
            updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
          }
        : null);
      const cleanChats = (Array.isArray(parsed.chats) ? parsed.chats : []).map(c => ({
        ...c,
        workspace: (typeof c?.workspace === 'string' && c.workspace.trim() !== '[object Object]') ? c.workspace.trim() : '',
        nativeSession: cleanSession(c?.nativeSession),
      }));
      return {
        version: 1,
        cookieKey: typeof parsed.cookieKey === 'string' && /^[a-f0-9]{64}$/i.test(parsed.cookieKey) ? parsed.cookieKey : base.cookieKey,
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        sharedFolders: cleanPaths(parsed.sharedFolders),
        favoriteFolders: cleanPaths(parsed.favoriteFolders),
        recentFolders: cleanPaths(parsed.recentFolders),
        chats: cleanChats,
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        try { renameSync(this.file, `${this.file}.corrupt.${Date.now()}`); } catch { /* ignore */ }
        const fallback = emptyState();
        this.writeState(fallback);
        return fallback;
      }
      throw error;
    }
  }

  writeState(state = this.state) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          renameSync(tmp, this.file);
          return;
        } catch (err) {
          if (attempt === 3 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
        }
      }
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
      if (existsSync(tmp)) { try { unlinkSync(tmp); } catch { /* ignore */ } }
    }
  }

  signSession(deviceId, secret) {
    return createHmac('sha256', Buffer.from(this.state.cookieKey, 'hex'))
      .update(`${deviceId}:${secret}`)
      .digest('hex');
  }

  pairDevice(label = 'Cihaz') {
    const id = randomUUID();
    const secret = randomBytes(24).toString('hex');
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + DEVICE_SESSION_TTL_MS).toISOString();
    const cleanLabel = String(label || 'Cihaz').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Cihaz';
    this.state.devices.push({
      id,
      label: cleanLabel,
      secretHash: sha(secret),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    });
    if (this.state.devices.length > 30) {
      // Preserve the oldest owner device at index 0 while trimming excess devices.
      this.state.devices = [this.state.devices[0], ...this.state.devices.slice(-29)];
    }
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
    if (device.expiresAt && Date.parse(device.expiresAt) <= Date.now()) return null;
    if (!safeEqual(sha(secret), device.secretHash)) return null;
    if (!safeEqual(mac, this.signSession(id, secret))) return null;
    const now = Date.now();
    if (!device.lastSeenAt || now - Date.parse(device.lastSeenAt) > 60_000) {
      device.lastSeenAt = new Date(now).toISOString();
      try { this.writeState(); } catch { /* non-fatal lastSeen update */ }
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
      nativeSession: null,
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
      const nextWs = patch.workspace.trim();
      if (nextWs !== (chat.workspace || '')) chat.nativeSession = null;
      chat.workspace = nextWs;
      if (chat.workspace) this.recordRecentFolder(chat.workspace);
    }
    chat.updatedAt = new Date().toISOString();
    this.writeState();
    return chat;
  }

  recordTaskSession(chatId, taskId, sessionId) {
    const cleanId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!cleanId) return null;
    const chat = this.getChat(chatId);
    if (!chat) return null;
    const msg = chat.messages.find(m => m.taskId === taskId);
    if (!msg) return null;
    const latestAssistant = [...chat.messages].reverse().find(m => m.role === 'assistant');
    const changedMsg = msg.sessionId !== cleanId;
    msg.sessionId = cleanId;
    const shouldPromote = !latestAssistant || latestAssistant.taskId === taskId;
    const prev = chat.nativeSession;
    const nextSession = {
      sessionId: cleanId,
      routeId: msg.routeId || '',
      modelId: msg.modelId || '',
      adapter: msg.adapter || '',
      group: msg.group || '',
      workspace: msg.workspace || '',
      updatedAt: new Date().toISOString(),
    };
    const changedChat = shouldPromote && (
      !prev ||
      prev.sessionId !== nextSession.sessionId ||
      prev.routeId !== nextSession.routeId ||
      prev.modelId !== nextSession.modelId ||
      prev.workspace !== nextSession.workspace
    );
    if (shouldPromote) chat.nativeSession = nextSession;
    if (changedMsg || changedChat) {
      chat.updatedAt = new Date().toISOString();
      this.writeState();
    }
    return chat.nativeSession;
  }

  clearChatNativeSession(chatId, onlyIfSessionId = '') {
    const chat = this.getChat(chatId);
    if (!chat || !chat.nativeSession) return false;
    if (onlyIfSessionId && chat.nativeSession.sessionId !== onlyIfSessionId) return false;
    chat.nativeSession = null;
    chat.updatedAt = new Date().toISOString();
    this.writeState();
    return true;
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
