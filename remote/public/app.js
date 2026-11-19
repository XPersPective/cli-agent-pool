(() => {
  'use strict';

  const THEME_KEY = 'remote-color-scheme';
  const SELECTION_KEY = 'remote-selection';
  const COLLAPSED_POOLS_KEY = 'remote-collapsed-pools';
  const TERMINAL_STATES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'needs_review']);

  const STATE_LABELS = {
    queued: ['Sırada', 'badge-warn'],
    running: ['Çalışıyor', 'badge-live'],
    succeeded: ['Tamamlandı', 'badge-ok'],
    failed: ['Hata', 'badge-danger'],
    timed_out: ['Zaman aşımı', 'badge-danger'],
    cancelled: ['İptal edildi', 'badge-warn'],
    needs_review: ['İnceleme gerekli', 'badge-warn'],
  };

  const EVENT_KIND_LABELS = {
    state: 'Durum',
    progress: 'İlerleme',
    tool: 'Araç',
    command: 'Komut',
    error_detail: 'Hata detayı',
    warning: 'Uyarı',
    info: 'Bilgi',
  };

  const state = {
    view: 'chat',
    remoteVersion: '',
    device: null,
    poolHealth: { status: 'stopped', version: null, connections: 0, models: 0, active: 0 },
    pools: [],
    models: [],
    quotas: [],
    connections: [],
    tasks: [],
    chats: [],
    activeChatId: null,
    activeChat: null,
    sharedFolders: [],
    favoriteFolders: [],
    recentFolders: [],
    workspaceRoots: [],
    canPickNativeFolder: false,
    devices: [],
    tailscaleIp: null,
    port: 43128,
    hostMode: '127.0.0.1',
    selection: {
      group: '',
      routeId: '',
      modelId: '',
      modelName: '',
      effort: '',
      efforts: [],
      includeContext: true,
    },
    collapsedPools: new Set(),
    poolSubtab: 'pools', // 'pools' | 'catalog' | 'quotas'
    poolsSearch: '',
    poolsToolFilter: 'all',
    pickerQuery: '',
    folderBrowser: { current: '', parent: '', entries: [], restricted: false, canBrowseAll: false },
    folderDialogPurpose: 'workspace', // 'workspace' | 'shared'
    pendingAttachments: [], // [{ name, size, content }]
    activeDoc: { name: '', content: '' },
    sending: false,
    streams: new Map(), // taskId -> EventSource
    recognition: null,
    recording: false,
    toastTimer: null,
  };

  const $ = id => document.getElementById(id);

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function toast(message, isError = false) {
    const box = $('toast');
    box.textContent = message;
    box.classList.toggle('error', Boolean(isError));
    box.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { box.hidden = true; }, isError ? 4800 : 2600);
  }

  async function api(url, opts = {}) {
    const headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `İstek hatası (${res.status})`);
      err.code = data?.error?.code || 'HTTP_ERROR';
      throw err;
    }
    return data;
  }

  function formatBytes(n) {
    const size = Number(n || 0);
    if (size < 1024) return `${size} B`;
    return `${(size / 1024).toFixed(1)} KB`;
  }

  function folderName(p) {
    if (!p || typeof p !== 'string' || p === '[object Object]') return 'Projesiz';
    const trimmed = p.trim();
    if (/^[a-zA-Z]:[\\/]?$/.test(trimmed)) return `${trimmed[0].toUpperCase()}:\\`;
    const clean = trimmed.replace(/[\\/]+$/, '');
    const parts = clean.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : clean;
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  function subscriptionText(item) {
    if (!item) return '';
    if (item.email) return item.email;
    if (item.account && item.account !== 'default') return item.account;
    if (item.routeId) return item.routeId;
    return '';
  }

  // --- Clean Error & Event Formatters ---
  function cleanErrorMessage(raw) {
    let text = String(raw || '').trim();
    if (!text) return '';
    for (let depth = 0; depth < 3; depth++) {
      if (!text.startsWith('{')) break;
      try {
        const parsed = JSON.parse(text);
        const candidate = parsed?.error?.message || parsed?.message || parsed?.detail;
        if (typeof candidate === 'string' && candidate.trim()) {
          text = candidate.trim();
          continue;
        }
      } catch { /* keep text */ }
      break;
    }
    return text;
  }

  function formatEventLine(ev) {
    if (typeof ev === 'string') return ev;
    if (!ev || typeof ev !== 'object') return '';
    const kindKey = ev.kind || ev.type || '';
    const label = EVENT_KIND_LABELS[kindKey] || kindKey || 'Adım';
    const rawDetail = ev.detail ?? ev.message ?? ev.summary ?? '';
    const detail = cleanErrorMessage(typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail));
    const time = ev.time ? formatTime(ev.time) : '';
    return [time, label, detail].filter(Boolean).join(' · ');
  }

  // --- Theme Management (dark-mode-toggle) ---
  function readSavedTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === 'dark' || v === 'light' || v === 'light dark') return v;
    } catch { /* ignore */ }
    return 'dark';
  }

  function applyTheme(value, persist = true) {
    const valid = (value === 'dark' || value === 'light' || value === 'light dark') ? value : 'dark';
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = valid;
    const isLight = valid === 'light' || (valid === 'light dark' && window.matchMedia('(prefers-color-scheme: light)').matches);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = isLight ? '#f6f7f9' : '#0b0d12';
    if (persist) {
      try { localStorage.setItem(THEME_KEY, valid); } catch { /* ignore */ }
    }
    document.querySelectorAll('[data-theme]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === valid);
      btn.setAttribute('aria-pressed', String(btn.dataset.theme === valid));
    });
  }

  window.addEventListener('storage', event => {
    if (event.key === THEME_KEY) applyTheme(event.newValue || 'dark', false);
  });

  // --- Light-Dismiss Dialog Fallback (Safari) ---
  function initDialogLightDismiss() {
    document.querySelectorAll('[data-close-dialog]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dlg = $(btn.dataset.closeDialog);
        if (dlg && dlg.open) dlg.close();
      });
    });

    if (!('closedBy' in HTMLDialogElement.prototype)) {
      document.querySelectorAll('dialog[closedby="any"]').forEach(dialog => {
        dialog.addEventListener('click', event => {
          if (event.target !== dialog) return;
          const rect = dialog.getBoundingClientRect();
          const inside = (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
          );
          if (!inside) dialog.close();
        });
      });
    }
  }

  // --- Persistence (Selection + Collapsed Pool Categories) ---
  function loadPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        const eff = typeof saved.effort === 'string' && saved.effort !== 'default' ? saved.effort : '';
        Object.assign(state.selection, {
          group: typeof saved.group === 'string' ? saved.group : '',
          routeId: typeof saved.routeId === 'string' ? saved.routeId : '',
          modelId: typeof saved.modelId === 'string' ? saved.modelId : '',
          modelName: typeof saved.modelName === 'string' ? saved.modelName : '',
          effort: eff,
          includeContext: saved.includeContext !== false,
        });
      }
    } catch { /* ignore */ }
    try {
      const collapsed = JSON.parse(localStorage.getItem(COLLAPSED_POOLS_KEY) || '[]');
      if (Array.isArray(collapsed)) state.collapsedPools = new Set(collapsed.filter(x => typeof x === 'string'));
    } catch { /* ignore */ }
  }

  function saveSelection() {
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify(state.selection)); } catch { /* ignore */ }
  }

  function togglePoolCollapsed(poolId) {
    if (state.collapsedPools.has(poolId)) state.collapsedPools.delete(poolId);
    else state.collapsedPools.add(poolId);
    try { localStorage.setItem(COLLAPSED_POOLS_KEY, JSON.stringify([...state.collapsedPools])); } catch { /* ignore */ }
  }

  function renderInlineQuotaTags(model) {
    const wrap = el('span', { className: 'model-quotas-inline' });
    const qStatus = model?.quotaStatus || model?.quota?.status || '';
    if (qStatus === 'auth_required') {
      wrap.appendChild(el('span', { className: 'q-tag danger', text: '🔒 Giriş gerekli' }));
      return wrap;
    }
    const wins = Array.isArray(model?.quotaWindows) && model.quotaWindows.length
      ? model.quotaWindows.slice(0, 2)
      : (model?.quota?.remainingPercent != null && Number.isFinite(model.quota.remainingPercent)
          ? [{ label: '', remainingPercent: Math.round(model.quota.remainingPercent) }]
          : []);
    for (const w of wins) {
      const pct = Math.round(w.remainingPercent);
      const cls = pct <= 10 ? 'q-tag danger' : pct <= 30 ? 'q-tag warn' : 'q-tag';
      wrap.appendChild(el('span', { className: cls }, [
        w.label ? `${w.label} ` : '',
        el('strong', { text: `%${pct}` }),
      ]));
    }
    return wrap;
  }

  function findModelObj(routeId, modelId) {
    if (!modelId) return null;
    for (const p of state.pools) {
      const m = (p.models || []).find(x => x.modelId === modelId && (!routeId || x.routeId === routeId));
      if (m) return m;
    }
    return state.models.find(x => x.modelId === modelId && (!routeId || x.routeId === routeId)) || null;
  }

  function findRouteMeta(routeId) {
    if (!routeId) return null;
    const q = (state.quotas || []).find(x => x.routeId === routeId);
    const c = (state.connections || []).find(x => x.id === routeId);
    if (!q && !c) return null;
    return {
      toolLabel: q?.toolLabel || c?.adapter || q?.adapter || '',
      email: q?.email || c?.email || '',
      account: c?.account || q?.account || '',
      billing: c?.billing || q?.billing || '',
    };
  }

  function updateSendButton() {
    const btn = $('send-btn');
    const input = $('prompt-input');
    if (!btn || !input) return;
    const hasContent = input.value.trim().length > 0 || state.pendingAttachments.length > 0;
    btn.disabled = state.sending || !hasContent;
    btn.classList.toggle('sending', state.sending);
    btn.setAttribute('aria-busy', String(state.sending));
  }

  // --- Universal Clipboard Helper (works on HTTPS, localhost, AND HTTP Tailscale mobile) ---
  async function copyText(text) {
    const value = String(text ?? '');
    if (!value) throw new Error('Kopyalanacak metin yok.');
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch { /* fall through to textarea fallback */ }
    }
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Tarayıcı panoya kopyalamaya izin vermedi.');
  }

  // --- Document Viewer & Downloader ---
  function downloadTextFile(filename, content) {
    const blob = new Blob([String(content || '')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'cikti.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openDocumentViewer(name, content) {
    state.activeDoc = { name: name || 'dokuman.md', content: String(content || '') };
    $('doc-dialog-title').textContent = state.activeDoc.name;
    const body = $('doc-dialog-body');
    const isMd = /\.(?:md|markdown)$/i.test(state.activeDoc.name);
    body.replaceChildren(isMd
      ? renderMarkdown(state.activeDoc.content)
      : el('pre', { className: 'code-block', text: state.activeDoc.content }));
    const dlg = $('doc-dialog');
    if (!dlg.open) dlg.showModal();
  }

  async function openWorkspaceFile(workspace, filePath) {
    if (!workspace || !filePath) return;
    try {
      const res = await api(`/r/file?workspace=${encodeURIComponent(workspace)}&file=${encodeURIComponent(filePath)}`);
      openDocumentViewer(res.name || filePath, res.content || '');
    } catch (err) { toast(err.message, true); }
  }

  // --- Document Attachments in Composer ---
  function renderAttachmentsStrip() {
    const strip = $('attachments-strip');
    strip.replaceChildren();
    strip.hidden = !state.pendingAttachments.length;
    state.pendingAttachments.forEach((att, idx) => {
      strip.appendChild(el('div', { className: 'att-chip' }, [
        el('button', {
          type: 'button',
          className: 'att-chip-name',
          style: 'border:0;background:transparent;padding:0;text-align:left',
          title: `${att.name} (${formatBytes(att.size)}) — Önizle`,
          text: `📄 ${att.name} (${formatBytes(att.size)})`,
          onClick: () => openDocumentViewer(att.name, att.content),
        }),
        el('button', {
          type: 'button',
          className: 'att-chip-rm',
          'aria-label': 'Dokümanı kaldır',
          text: '✕',
          onClick: () => {
            state.pendingAttachments.splice(idx, 1);
            renderAttachmentsStrip();
            updateSendButton();
          },
        }),
      ]));
    });
    updateSendButton();
  }

  async function addFilesAsAttachments(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (state.pendingAttachments.length >= 5) {
        toast('Tek mesajda en fazla 5 doküman eklenebilir.', true);
        break;
      }
      if (file.size > 204_800) {
        toast(`"${file.name}" çok büyük (en fazla 200 KB).`, true);
        continue;
      }
      try {
        const text = await file.text();
        if (text.includes('\u0000')) {
          toast(`"${file.name}" metin tabanlı bir doküman değil.`, true);
          continue;
        }
        state.pendingAttachments.push({ name: file.name, size: file.size, content: text });
      } catch {
        toast(`"${file.name}" okunamadı.`, true);
      }
    }
    renderAttachmentsStrip();
  }

  // --- Safe Markdown DOM Renderer (zero innerHTML) ---
  function renderInline(text) {
    const frag = document.createDocumentFragment();
    const parts = String(text || '').split(/(`[^`]+`)/g);
    for (const part of parts) {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
        frag.appendChild(el('code', { className: 'md-inline-code', text: part.slice(1, -1) }));
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    }
    return frag;
  }

  function renderMarkdown(text) {
    const root = el('div', { className: 'md-content' });
    const raw = String(text || '');
    if (!raw.trim()) return root;

    const segments = raw.split(/(```[\s\S]*?```)/g);
    for (const seg of segments) {
      if (!seg) continue;
      if (seg.startsWith('```') && seg.endsWith('```') && seg.length >= 6) {
        const inner = seg.slice(3, -3);
        const firstNl = inner.indexOf('\n');
        const lang = firstNl >= 0 ? inner.slice(0, firstNl).trim() : '';
        const code = firstNl >= 0 ? inner.slice(firstNl + 1) : inner;
        const ext = lang && /^[a-z0-9]+$/i.test(lang) ? lang : 'txt';
        const copyBtn = el('button', {
          type: 'button',
          className: 'code-copy-btn',
          text: 'Kopyala',
          onClick: async () => {
            try {
              await copyText(code);
              copyBtn.textContent = 'Kopyalandı';
              setTimeout(() => { copyBtn.textContent = 'Kopyala'; }, 1500);
            } catch { toast('Kopyalanamadı', true); }
          },
        });
        const dlBtn = el('button', {
          type: 'button',
          className: 'code-copy-btn',
          text: '⬇ İndir',
          onClick: () => downloadTextFile(`cikti.${ext}`, code),
        });
        root.appendChild(el('div', { className: 'code-card' }, [
          el('div', { className: 'code-card-head' }, [
            el('span', { text: lang || 'kod' }),
            el('span', { className: 'inline-btn-group' }, [copyBtn, dlBtn]),
          ]),
          el('pre', {}, el('code', { text: code })),
        ]));
        continue;
      }

      const lines = seg.split('\n');
      let listEl = null;
      let paraLines = [];

      const flushPara = () => {
        if (!paraLines.length) return;
        const p = el('p');
        p.appendChild(renderInline(paraLines.join('\n')));
        root.appendChild(p);
        paraLines = [];
      };
      const flushList = () => { listEl = null; };

      for (const line of lines) {
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        if (!line.trim()) {
          flushPara();
          flushList();
        } else if (heading) {
          flushPara();
          flushList();
          const h = el(heading[1].length <= 2 ? 'h3' : 'h4');
          h.appendChild(renderInline(heading[2]));
          root.appendChild(h);
        } else if (bullet) {
          flushPara();
          if (!listEl) {
            listEl = el('ul');
            root.appendChild(listEl);
          }
          const li = el('li');
          li.appendChild(renderInline(bullet[1]));
          listEl.appendChild(li);
        } else {
          flushList();
          paraLines.push(line);
        }
      }
      flushPara();
    }
    return root;
  }

  // --- View Switching & Mobile Back-Gesture History Management ---
  function pushHistoryGuard(tag) {
    try { history.pushState({ capRemote: true, tag }, ''); } catch { /* ignore */ }
  }

  function switchView(view, { fromPopstate = false } = {}) {
    const prev = state.view;
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    document.querySelectorAll('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    const isChat = view === 'chat';
    $('topbar-back-btn').hidden = isChat;
    $('topbar-brand-icon').hidden = !isChat;
    if (view === 'chats') renderChatGroups($('mobile-chat-list'), true);
    if (view === 'calls' || view === 'pools' || view === 'settings') void refreshState(false);
    if (!fromPopstate && view !== prev) pushHistoryGuard(`view:${view}`);
  }

  function initMobileBackNavigation() {
    try {
      history.replaceState({ capRemote: true, tag: 'root' }, '');
      history.pushState({ capRemote: true, tag: 'view:chat' }, '');
    } catch { /* ignore */ }
    window.addEventListener('popstate', () => {
      // 1. If any dialog is open, Back closes the dialog cleanly instead of leaving the app.
      const openDialogs = [...document.querySelectorAll('dialog[open]')];
      if (openDialogs.length) {
        openDialogs[openDialogs.length - 1].close();
        pushHistoryGuard(`view:${state.view}`);
        return;
      }
      // 2. If on another view (Sohbetler / Çağrılar / Havuzlar / Ayarlar), Back returns to Chat.
      if (state.view !== 'chat') {
        switchView('chat', { fromPopstate: true });
        pushHistoryGuard('view:chat');
        return;
      }
      // 3. If already inside Chat, Back switches cleanly to the Chats list (never kicks out of the app).
      switchView('chats', { fromPopstate: true });
      pushHistoryGuard('view:chats');
    });
  }

  // --- Rendering Topbar, Composer Inline Model & Workspace Strip ---
  function renderTopbarAndStatus() {
    const running = state.poolHealth?.status === 'ok';
    const active = Number(state.poolHealth?.active || 0);
    $('pool-dot').className = `status-dot ${running ? 'ok' : 'danger'}`;
    $('pool-chip-label').textContent = running ? (active > 0 ? `Pool (${active})` : 'Pool') : 'Kapalı';
    $('sidebar-pool-status').textContent = running
      ? `v${state.poolHealth.version || '?'} · ${state.poolHealth.models || 0} model`
      : 'Servis kapalı';
    $('pool-offline-banner').hidden = running;

    const navBadge = $('nav-active-badge');
    navBadge.hidden = active <= 0;
    navBadge.textContent = String(active);
    $('bnav-active-badge').hidden = active <= 0;

    const ws = state.activeChat?.workspace || '';
    $('topbar-chat-title').textContent = state.activeChat?.title || 'Yeni sohbet';
    $('topbar-chat-sub').textContent = ws ? `📁 ${folderName(ws)}` : '💬 Projesiz sohbet';

    // Inline Antigravity-style Model Button inside Composer Bottom-Left
    const sel = state.selection;
    const poolObj = state.pools.find(p => p.id === sel.group);
    const poolLabel = poolObj?.label || sel.group;
    let title = 'Otomatik Model';
    let meta = poolLabel || '';
    let dotClass = running ? 'mini-dot ok' : 'mini-dot warn';

    if (sel.modelId) {
      const found = findModelObj(sel.routeId, sel.modelId);
      title = found?.name || sel.modelName || sel.modelId;
      const parts = [];
      if (sel.effort && sel.effort !== 'default') parts.push(sel.effort);
      if (found?.toolLabel) parts.push(found.toolLabel);
      if (found?.quotaWindows?.length) {
        parts.push(found.quotaWindows.slice(0, 2).map(w => `${w.label} %${w.remainingPercent}`).join(' '));
      } else if (found?.quota?.remainingPercent != null) {
        parts.push(`%${Math.round(found.quota.remainingPercent)}`);
      }
      meta = parts.join(' · ');
      const minPct = found?.quota?.remainingPercent;
      if (minPct != null && minPct <= 10) dotClass = 'mini-dot danger';
      else if (minPct != null && minPct <= 30) dotClass = 'mini-dot warn';
    }
    $('model-pill-dot').className = dotClass;
    $('model-pill-name').textContent = title;
    $('model-pill-meta').textContent = meta;

    const ctxBtn = $('context-toggle-btn');
    ctxBtn.classList.toggle('active', sel.includeContext);
    ctxBtn.setAttribute('aria-pressed', String(sel.includeContext));
    $('context-toggle-label').textContent = sel.includeContext ? 'Bağlam: Özet' : 'Bağlam: Kapalı';
    updateSendButton();
  }

  function renderWorkspaceStrip() {
    const ws = state.activeChat?.workspace || '';
    const pill = $('folder-picker-btn');
    pill.classList.toggle('has-project', Boolean(ws));
    $('current-folder-icon').textContent = ws ? '📁' : '💬';
    $('current-folder-label').textContent = ws ? folderName(ws) : 'Projesiz (Sohbet)';
    pill.title = ws || 'Proje klasörü seçin (seçilmezse sohbet modunda çalışır)';
  }

  // --- Grouped Chats by Project Folder ---
  function renderChatGroups(container, isMobileView = false) {
    if (!container) return;
    container.replaceChildren();

    const groups = new Map();
    groups.set('', []);
    for (const dir of [...state.sharedFolders, ...state.favoriteFolders]) {
      if (typeof dir === 'string' && dir && dir !== '[object Object]' && !groups.has(dir)) groups.set(dir, []);
    }
    for (const chat of state.chats) {
      const key = (typeof chat.workspace === 'string' && chat.workspace !== '[object Object]') ? chat.workspace : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(chat);
    }

    for (const [folderPath, chats] of groups.entries()) {
      const groupWrap = el('div', { className: isMobileView ? 'panel-card chat-folder-group' : 'chat-folder-group' });
      const head = el('div', { className: 'chat-folder-head' }, [
        el('div', { className: 'chat-folder-name', title: folderPath || 'Proje klasörü olmadan sohbetler' }, [
          el('span', { text: folderPath ? '📁' : '💬' }),
          el('span', { text: folderPath ? folderName(folderPath) : 'Projesiz Sohbetler' }),
        ]),
        el('button', {
          type: 'button',
          className: 'folder-add-chat-btn',
          title: folderPath ? `${folderName(folderPath)} içinde yeni sohbet` : 'Yeni projesiz sohbet',
          'aria-label': folderPath ? `${folderName(folderPath)} içinde yeni sohbet` : 'Yeni projesiz sohbet',
          text: '+',
          onClick: () => {
            switchView('chat');
            void createNewChat(folderPath);
          },
        }),
      ]);
      groupWrap.appendChild(head);

      if (!chats.length) {
        groupWrap.appendChild(el('div', { className: 'chat-item-meta', style: 'padding: 2px 12px 4px', text: 'Henüz sohbet yok' }));
      } else {
        for (const chat of chats) {
          groupWrap.appendChild(el('div', { className: `chat-item${chat.id === state.activeChatId ? ' active' : ''}`, role: 'listitem' }, [
            el('button', {
              type: 'button',
              className: 'chat-item-main',
              onClick: () => {
                switchView('chat');
                void openChat(chat.id);
              },
            }, [
              el('div', { className: 'chat-item-title', text: chat.title || 'Yeni sohbet' }),
              el('div', { className: 'chat-item-meta', text: `${chat.messageCount || 0} mesaj · ${formatTime(chat.updatedAt)}` }),
            ]),
            el('button', {
              type: 'button',
              className: 'chat-del-btn',
              'aria-label': 'Sohbeti sil',
              title: 'Sohbeti sil',
              text: '🗑',
              onClick: async e => {
                e.stopPropagation();
                if (!window.confirm(`"${chat.title || 'Bu sohbet'}" silinsin mi?`)) return;
                try {
                  await api(`/r/chats/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
                  if (state.activeChatId === chat.id) {
                    state.activeChatId = null;
                    state.activeChat = null;
                  }
                  await refreshState(false);
                  toast('Sohbet silindi.');
                } catch (err) { toast(err.message, true); }
              },
            }),
          ]));
        }
      }
      container.appendChild(groupWrap);
    }
  }

  function renderChatList() {
    renderChatGroups($('chat-list'), false);
    if (state.view === 'chats') renderChatGroups($('mobile-chat-list'), true);
  }

  // --- Messages Rendering (with Tool + Subscription + Document Preview/Download) ---
  function describeQueueReason(queueReason, workspace) {
    const folder = workspace ? folderName(workspace) : 'bu klasör';
    if (queueReason === 'WORKSPACE_REVIEW_REQUIRED') {
      return `⏳ "${folder}" önceki bir dosya düzenleme çağrısı nedeniyle inceleme kilidinde. Kilidi kaldırdığınızda bekleyen çağrılar başlar.`;
    }
    if (queueReason === 'WORKSPACE_BUSY') {
      return `⏳ "${folder}" içinde şu anda başka bir dosya düzenleme çağrısı çalışıyor; dosya çakışmasını önlemek için sıraya alındı. Farklı klasörler veya salt okuma/sohbet çağrıları paralel çalışır.`;
    }
    return '⏳ Çağrı başlatılmak üzere sırada bekliyor…';
  }

  async function resolveReviewLock(taskId, reloadChat = false) {
    try {
      await api(`/r/tasks/${encodeURIComponent(taskId)}/resolve`, { method: 'POST', body: {} });
      toast('İnceleme kilidi kaldırıldı, bekleyen çağrılar başlatılıyor.');
      if (reloadChat && state.activeChatId) await openChat(state.activeChatId);
      await refreshState(false);
    } catch (err) { toast(err.message, true); }
  }

  function renderAssistantBubble(msg) {
    const [stateLabel, stateCls] = STATE_LABELS[msg.state] || [msg.state || 'Bekliyor', 'badge'];
    const isActive = msg.taskId && !TERMINAL_STATES.has(msg.state);
    const liveMeta = findRouteMeta(msg.routeId);
    const toolName = msg.toolLabel || liveMeta?.toolLabel || '';
    const subName = subscriptionText({ email: msg.email || liveMeta?.email, account: msg.account || liveMeta?.account, routeId: msg.routeId });

    const statusBadge = el('span', { className: `badge ${stateCls}` }, [
      isActive ? el('span', { className: 'pulse-dot' }) : null,
      stateLabel,
    ]);

    const isRawReportJson = (text, report) => {
      if (!report || !text) return false;
      const trimmed = String(text).trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
      try {
        const parsed = JSON.parse(trimmed);
        return Boolean(parsed && typeof parsed === 'object' && 'status' in parsed && 'summary' in parsed);
      } catch { return false; }
    };

    const headRight = el('div', { className: 'topbar-right' }, [
      statusBadge,
      msg.state === 'needs_review' && msg.taskId ? el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        text: '✓ İncelemeyi Kapat',
        onClick: () => void resolveReviewLock(msg.taskId, true),
      }) : null,
      isActive ? el('button', {
        type: 'button',
        className: 'btn btn-danger btn-sm',
        text: 'İptal',
        onClick: async () => {
          try {
            await api(`/r/tasks/${encodeURIComponent(msg.taskId)}/cancel`, { method: 'POST', body: {} });
            toast('İptal isteği gönderildi.');
          } catch (err) { toast(err.message, true); }
        },
      }) : null,
      msg.taskId ? el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        text: 'Detay',
        onClick: () => void openTaskInspector(msg.taskId),
      }) : null,
    ]);

    const modelText = [
      msg.reportedModel || msg.modelId || 'Otomatik',
      msg.effort && msg.effort !== 'default' ? `(${msg.effort})` : '',
    ].filter(Boolean).join(' ');

    const bodyNodes = [
      el('div', { className: 'msg-head' }, [
        el('div', { className: 'msg-model-stack' }, [
          el('span', { className: 'msg-model-tag', text: modelText }),
          toolName ? el('span', { className: 'tool-pill', text: toolName }) : null,
          subName ? el('span', { className: 'sub-pill', title: subName, text: subName }) : null,
        ]),
        headRight,
      ]),
    ];

    if (msg.error) {
      const friendlyErr = msg.error === 'WORK_INCOMPLETE' && msg.report?.blockers?.length
        ? `Görev tamamlanmadı: ${msg.report.blockers.join(' · ')}`
        : cleanErrorMessage(msg.errorDetail || msg.error);
      bodyNodes.push(el('div', { className: 'error-box', text: friendlyErr }));
    }

    const rawOutput = msg.result || msg.text || '';
    const hideRawJson = isRawReportJson(rawOutput, msg.report);
    const displayText = hideRawJson ? (msg.report?.summary || '') : rawOutput;
    const msgWorkspace = msg.workspace || state.activeChat?.workspace || '';

    if (msg.state === 'queued') {
      const qChildren = [el('div', { text: describeQueueReason(msg.queueReason, msgWorkspace) })];
      if (msg.queueReason === 'WORKSPACE_REVIEW_REQUIRED' && msg.blockedBy) {
        qChildren.push(el('div', { className: 'btn-row', style: 'margin-top:0' }, [
          el('button', {
            type: 'button',
            className: 'btn btn-primary btn-sm',
            text: '🔓 Proje Kilidini Aç',
            onClick: () => void resolveReviewLock(msg.blockedBy, true),
          }),
          el('button', {
            type: 'button',
            className: 'btn btn-secondary btn-sm',
            text: 'Engelleyen Çağrıyı Gör',
            onClick: () => void openTaskInspector(msg.blockedBy),
          }),
        ]));
      }
      bodyNodes.push(el('div', { className: 'queue-box' }, qChildren));
    } else if (displayText) {
      bodyNodes.push(renderMarkdown(displayText));
    } else if (isActive) {
      bodyNodes.push(el('p', { className: 'muted', text: 'Ajan çalışıyor, adımlar canlı olarak izleniyor…' }));
    }

    if (msg.report && (msg.report.files?.length || msg.report.checks?.length || (!hideRawJson && msg.report.summary && msg.report.summary !== displayText))) {
      const reportChildren = [];
      if (!hideRawJson && msg.report.summary && msg.report.summary !== displayText) {
        reportChildren.push(el('div', { text: msg.report.summary }));
      }
      if (Array.isArray(msg.report.checks) && msg.report.checks.length) {
        reportChildren.push(el('div', { className: 'report-files' }, msg.report.checks.slice(0, 12).map(ch =>
          el('span', { className: 'file-pill', text: `${ch.outcome === 'passed' ? '✓' : ch.outcome === 'failed' ? '✕' : '○'} ${ch.command}` }),
        )));
      }
      if (Array.isArray(msg.report.files) && msg.report.files.length) {
        reportChildren.push(el('div', { className: 'report-files' }, msg.report.files.slice(0, 20).map(f => {
          const fPath = typeof f === 'string' ? f : (f.path || '');
          const label = `${f.status ? `${f.status} ` : ''}📄 ${fPath}`;
          return msgWorkspace && fPath
            ? el('button', {
                type: 'button',
                className: 'file-pill-btn',
                title: 'Dosyayı önizle / indir',
                text: label,
                onClick: () => void openWorkspaceFile(msgWorkspace, fPath),
              })
            : el('span', { className: 'file-pill', text: label });
        })));
      }
      if (reportChildren.length) bodyNodes.push(el('div', { className: 'report-box' }, reportChildren));
    }

    if (Array.isArray(msg.events) && msg.events.length) {
      const formatted = msg.events.slice(-12).map(formatEventLine).filter(Boolean);
      if (formatted.length) {
        bodyNodes.push(el('details', { className: 'events-details', ...(isActive ? { open: true } : {}) }, [
          el('summary', { text: `Adımlar & olaylar (${msg.events.length})` }),
          el('ul', { className: 'events-list' }, formatted.map(line => el('li', { text: line }))),
        ]));
      }
    }

    if (displayText) {
      bodyNodes.push(el('div', { className: 'msg-doc-actions' }, [
        el('button', {
          type: 'button',
          className: 'mini-action-btn',
          text: '📋 Kopyala',
          onClick: async () => {
            try { await copyText(displayText); toast('Yanıt kopyalandı.'); }
            catch { toast('Kopyalanamadı.', true); }
          },
        }),
        el('button', {
          type: 'button',
          className: 'mini-action-btn',
          text: '👁️ Doküman Gör',
          onClick: () => openDocumentViewer(`${(msg.reportedModel || msg.modelId || 'yanit').replace(/[^a-z0-9._-]/gi, '_')}.md`, displayText),
        }),
        el('button', {
          type: 'button',
          className: 'mini-action-btn',
          text: '⬇ .md İndir',
          onClick: () => downloadTextFile(`${(msg.reportedModel || msg.modelId || 'yanit').replace(/[^a-z0-9._-]/gi, '_')}.md`, displayText),
        }),
      ]));
    }

    return el('article', { className: 'msg msg-assistant' }, [
      el('div', { className: 'msg-bubble' }, bodyNodes),
      el('div', { className: 'msg-meta', text: [toolName, subName, formatTime(msg.at)].filter(Boolean).join(' · ') }),
    ]);
  }

  function renderMessages(scrollToBottom = false) {
    const messages = state.activeChat?.messages || [];
    $('empty-chat-state').hidden = messages.length > 0;
    const list = $('messages-list');
    list.replaceChildren();

    for (const msg of messages) {
      if (msg.role === 'user') {
        const bubbleChildren = [];
        if (msg.text) bubbleChildren.push(el('div', { text: msg.text }));
        if (Array.isArray(msg.attachments) && msg.attachments.length) {
          bubbleChildren.push(el('div', { className: 'report-files', style: 'margin-top:6px' }, msg.attachments.map(att =>
            el('button', {
              type: 'button',
              className: 'file-pill-btn',
              text: `📄 ${att.name} (${formatBytes(att.size)})`,
              onClick: () => openDocumentViewer(att.name, att.content || '(Önizleme yok)'),
            }),
          )));
        }
        list.appendChild(el('article', { className: 'msg msg-user' }, [
          el('div', { className: 'msg-bubble' }, bubbleChildren),
          el('div', { className: 'msg-meta', text: [
            msg.workspace ? `📁 ${folderName(msg.workspace)}` : '💬 Sohbet',
            msg.includeContext === false ? 'Sıfır bağlam' : '',
            formatTime(msg.at),
          ].filter(Boolean).join(' · ') }),
        ]));
      } else {
        list.appendChild(renderAssistantBubble(msg));
      }
    }

    if (scrollToBottom) {
      const feed = $('messages-feed');
      feed.scrollTop = feed.scrollHeight;
    }
  }

  // --- Calls View (with Clear History + Delete Individual Call + Tool/Subscription Pills) ---
  function renderCallsView() {
    const container = $('calls-list');
    container.replaceChildren();
    if (!state.tasks.length) {
      container.appendChild(el('div', { className: 'panel-card' }, [
        el('p', { className: 'muted', text: state.poolHealth?.status === 'ok' ? 'Henüz çağrı kaydı yok.' : 'Servis kapalı olduğu için çağrılar listelenemiyor.' }),
      ]));
      return;
    }
    for (const task of state.tasks) {
      const [label, cls] = STATE_LABELS[task.state] || [task.state || '?', 'badge'];
      const active = !TERMINAL_STATES.has(task.state);
      const subName = subscriptionText(task);
      container.appendChild(el('div', { className: 'panel-card' }, [
        el('div', { className: 'card-row' }, [
          el('div', { style: 'min-width:0' }, [
            el('div', { className: 'msg-model-stack' }, [
              el('strong', { text: task.reportedModel || task.modelId || task.routeId || 'Görev' }),
              task.toolLabel ? el('span', { className: 'tool-pill', text: task.toolLabel }) : null,
              subName ? el('span', { className: 'sub-pill', text: subName }) : null,
            ]),
            el('p', { className: 'muted', text: `${task.workspace ? folderName(task.workspace) : 'Sohbet'}${task.clientLabel ? ` · ${task.clientLabel}` : ''}` }),
          ]),
          el('span', { className: `badge ${cls}` }, [active ? el('span', { className: 'pulse-dot' }) : null, label]),
        ]),
        task.state === 'queued' ? el('div', { className: 'queue-box' }, [
          el('div', { text: describeQueueReason(task.queueReason, task.workspace) }),
        ]) : null,
        task.result ? el('p', { className: 'muted', style: 'margin-top:6px', text: String(task.result).slice(0, 180) }) : null,
        task.error ? el('div', { className: 'error-box', style: 'margin-top:6px', text: cleanErrorMessage(task.errorDetail || task.error) }) : null,
        el('div', { className: 'btn-row' }, [
          el('button', { type: 'button', className: 'btn btn-secondary btn-sm', text: 'İncele', onClick: () => void openTaskInspector(task.id) }),
          task.state === 'needs_review' ? el('button', {
            type: 'button',
            className: 'btn btn-primary btn-sm',
            text: '✓ İncelemeyi Kapat',
            onClick: () => void resolveReviewLock(task.id, false),
          }) : null,
          task.state === 'queued' && task.queueReason === 'WORKSPACE_REVIEW_REQUIRED' && task.blockedBy ? el('button', {
            type: 'button',
            className: 'btn btn-primary btn-sm',
            text: '🔓 Engelleyen Kilidi Aç',
            onClick: () => void resolveReviewLock(task.blockedBy, false),
          }) : null,
          active ? el('button', {
            type: 'button',
            className: 'btn btn-danger btn-sm',
            text: 'İptal Et',
            onClick: async () => {
              try {
                await api(`/r/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', body: {} });
                toast('Görev iptal ediliyor.');
                await refreshState(false);
              } catch (err) { toast(err.message, true); }
            },
          }) : el('button', {
            type: 'button',
            className: 'btn btn-ghost btn-sm',
            text: 'Sil',
            onClick: async () => {
              try {
                await api(`/r/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
                toast('Çağrı kaydı silindi.');
                await refreshState(false);
              } catch (err) { toast(err.message, true); }
            },
          }),
        ]),
      ]));
    }
  }

  // --- Shared Quotas Card Builder (Used in BOTH #quotas-dialog overlay AND #view-pools) ---
  function renderQuotaCardsInto(container) {
    container.replaceChildren();
    if (!state.quotas.length) {
      container.appendChild(el('p', { className: 'muted', text: 'Kota kaydı yok veya CLI Agent Pool servisi kapalı.' }));
      return;
    }
    for (const q of state.quotas) {
      const pct = Number.isFinite(q.remainingPercent) ? Math.round(q.remainingPercent) : null;
      const isAuthReq = q.status === 'auth_required';
      const fillCls = pct == null ? '' : pct <= 10 ? ' danger' : pct <= 30 ? ' warn' : '';
      const statusText = isAuthReq ? '🔒 Giriş gerekli'
        : q.status === 'rate_limited' ? 'Kota doldu'
          : pct != null ? `%${pct}` : (q.status === 'available' ? 'Hazır' : 'Bilinmiyor');
      const badgeCls = isAuthReq || q.status === 'rate_limited' ? 'badge badge-danger' : 'badge';
      const winsRow = Array.isArray(q.windows) && q.windows.length
        ? el('div', { className: 'quota-win-row' }, q.windows.slice(0, 6).map(w => {
            const wp = Math.round(w.remainingPercent);
            const cls = wp <= 10 ? 'q-tag danger' : wp <= 30 ? 'q-tag warn' : 'q-tag';
            return el('span', { className: cls }, [`${w.name.split(':').pop() || w.name} `, el('strong', { text: `%${wp}` })]);
          }))
        : null;
      container.appendChild(el('div', { className: 'quota-card' }, [
        el('div', { className: 'card-row' }, [
          el('div', { className: 'msg-model-stack' }, [
            el('strong', { text: q.toolLabel || q.adapter || q.routeId || 'Bağlantı' }),
            q.email ? el('span', { className: 'sub-pill', text: q.email }) : el('span', { className: 'sub-pill', text: q.routeId }),
          ]),
          el('span', { className: badgeCls, text: statusText }),
        ]),
        el('div', { className: 'muted', text: `${q.billing || ''} · ${q.models || 0} model${q.note ? ` · ${q.note}` : ''}` }),
        pct != null ? el('div', { className: 'quota-bar' }, el('div', { className: `quota-fill${fillCls}`, style: `width:${Math.max(0, Math.min(100, pct))}%` })) : null,
        winsRow,
        el('div', { className: 'btn-row', style: 'margin-top:6px' }, [
          isAuthReq ? el('button', {
            type: 'button',
            className: 'btn btn-primary btn-sm',
            text: '🔑 Giriş Yap',
            onClick: async () => {
              try {
                const res = await api(`/r/routes/${encodeURIComponent(q.routeId)}/login`, { method: 'POST', body: {} });
                toast(res.message || 'Giriş penceresi bilgisayarda açıldı; girişten sonra Kontrol Et düğmesine basın.');
              } catch (err) { toast(err.message, true); }
            },
          }) : null,
          el('button', {
            type: 'button',
            className: 'btn btn-secondary btn-sm',
            text: '🔄 Kontrol Et',
            onClick: async () => {
              toast(`${q.routeId} oturum ve kotası kontrol ediliyor…`);
              try {
                await api(`/r/routes/${encodeURIComponent(q.routeId)}/refresh-auth`, { method: 'POST', body: {} });
                await refreshState(false);
                toast(`${q.routeId} güncellendi.`);
              } catch (err) { toast(err.message, true); }
            },
          }),
        ]),
      ]));
    }
  }

  function openQuotasOverlay() {
    renderQuotaCardsInto($('quotas-dialog-body'));
    const dlg = $('quotas-dialog');
    if (!dlg.open) dlg.showModal();
  }

  // --- Full CLI Agent Pool Management Inside #view-pools (Havuzlarım | Model Kataloğu | Kotalar) ---
  async function mutatePoolMembership(routeId, modelId, group, action) {
    try {
      await api('/r/pool/membership', { method: 'POST', body: { routeId, modelId, group, action } });
      toast(action === 'add' ? `Model "${group}" havuzuna eklendi.` : `Model "${group}" havuzundan çıkarıldı.`);
      await refreshState(false);
    } catch (err) { toast(err.message, true); }
  }

  function renderPoolsView() {
    document.querySelectorAll('[data-pool-subtab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.poolSubtab === state.poolSubtab);
    });

    // Tool filter chips
    const toolBar = $('pools-tool-chips');
    toolBar.replaceChildren();
    const tools = [...new Set(state.models.map(m => m.toolLabel || m.adapter).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
    if (state.poolSubtab !== 'quotas' && tools.length) {
      toolBar.hidden = false;
      for (const t of ['all', ...tools]) {
        toolBar.appendChild(el('button', {
          type: 'button',
          className: `chip-btn${state.poolsToolFilter === t ? ' active' : ''}`,
          text: t === 'all' ? 'Tümü' : t,
          onClick: () => {
            state.poolsToolFilter = t;
            renderPoolsView();
          },
        }));
      }
    } else {
      toolBar.hidden = true;
    }

    const qStrip = $('quotas-summary');
    const grid = $('pools-grid');
    grid.replaceChildren();

    if (state.poolSubtab === 'quotas') {
      qStrip.hidden = false;
      renderQuotaCardsInto(qStrip);
      return;
    }
    qStrip.hidden = true;

    const q = state.poolsSearch.trim().toLowerCase();
    const matchesFilter = m => {
      if (state.poolsToolFilter !== 'all' && (m.toolLabel || m.adapter) !== state.poolsToolFilter) return false;
      if (!q) return true;
      return [m.name, m.modelId, m.routeId, m.toolLabel, m.email, m.account, m.billing].some(s => String(s || '').toLowerCase().includes(q));
    };

    if (state.poolSubtab === 'pools') {
      if (!state.pools.length) {
        grid.appendChild(el('div', { className: 'panel-card' }, el('p', { className: 'muted', text: 'Havuz bulunamadı veya servis kapalı.' })));
        return;
      }
      for (const pool of state.pools) {
        const models = (pool.models || []).filter(matchesFilter);
        if (q && !models.length) continue;
        const isCollapsed = !q && state.collapsedPools.has(pool.id);

        const card = el('div', { className: 'panel-card' }, [
          el('div', { className: 'card-row' }, [
            el('button', {
              type: 'button',
              className: 'picker-cat-toggle',
              'aria-expanded': String(!isCollapsed),
              onClick: () => { togglePoolCollapsed(pool.id); renderPoolsView(); },
            }, [
              el('span', { className: 'picker-cat-chevron', text: isCollapsed ? '▸' : '▾' }),
              el('span', { text: `${pool.label || pool.id} (${models.length})` }),
            ]),
            el('button', {
              type: 'button',
              className: 'btn btn-secondary btn-sm',
              text: 'Havuzu Seç',
              onClick: () => {
                choosePoolAuto(pool.id);
                switchView('chat');
                toast(`${pool.label || pool.id} havuzu seçildi.`);
              },
            }),
          ]),
        ]);

        if (!isCollapsed) {
          const listWrap = el('div', { className: 'picker-list', style: 'margin-top:8px' });
          if (!models.length) {
            listWrap.appendChild(el('p', { className: 'muted', text: 'Bu havuzda eşleşen model yok.' }));
          } else {
            for (const m of models) {
              const selected = state.selection.modelId === m.modelId && state.selection.routeId === m.routeId;
              listWrap.appendChild(el('div', { className: `pool-mgmt-row${selected ? ' selected' : ''}` }, [
                el('div', { className: 'model-row-text', style: 'flex:1;min-width:160px' }, [
                  el('div', { className: 'msg-model-stack' }, [
                    el('strong', { className: 'model-row-name', text: m.name || m.modelId }),
                    m.toolLabel ? el('span', { className: 'tool-pill', text: m.toolLabel }) : null,
                    subscriptionText(m) ? el('span', { className: 'sub-pill', text: subscriptionText(m) }) : null,
                  ]),
                  m.efforts?.length ? el('div', { className: 'model-row-sub', text: `efor: ${m.efforts.join(' · ')}` }) : null,
                ]),
                el('div', { className: 'pool-mgmt-actions' }, [
                  renderInlineQuotaTags(m),
                  el('button', {
                    type: 'button',
                    className: 'mini-action-btn',
                    text: selected ? '✓ Seçili' : 'Seç',
                    onClick: () => {
                      chooseModel({ ...m, group: pool.id });
                      switchView('chat');
                      toast(`${m.name || m.modelId} seçildi.`);
                    },
                  }),
                  el('button', {
                    type: 'button',
                    className: 'mini-action-btn',
                    style: 'color:var(--danger)',
                    text: 'Çıkar',
                    onClick: () => void mutatePoolMembership(m.routeId, m.modelId, pool.id, 'remove'),
                  }),
                ]),
              ]));
            }
          }
          card.appendChild(listWrap);
        }
        grid.appendChild(card);
      }
      return;
    }

    // Catalog sub-tab: browse ALL models and add to any pool category
    const catModels = state.models.filter(matchesFilter);
    if (!catModels.length) {
      grid.appendChild(el('div', { className: 'panel-card' }, el('p', { className: 'muted', text: 'Katalogda eşleşen model bulunamadı.' })));
      return;
    }
    const catCard = el('div', { className: 'panel-card' }, [
      el('div', { className: 'card-row' }, [
        el('h3', { text: `Model Kataloğu (${catModels.length})` }),
      ]),
    ]);
    const listWrap = el('div', { className: 'picker-list', style: 'margin-top:8px' });
    for (const m of catModels) {
      const selected = state.selection.modelId === m.modelId && state.selection.routeId === m.routeId;
      const memberGroups = new Set(Array.isArray(m.categories) ? m.categories : (m.category ? [m.category] : []));
      const addablePools = state.pools.filter(p => !memberGroups.has(p.id));
      const addSelect = addablePools.length
        ? el('select', {
            className: 'pool-add-select',
            'aria-label': `${m.name || m.modelId} havuza ekle`,
            onChange: e => {
              const targetGroup = e.target.value;
              e.target.value = '';
              if (targetGroup) void mutatePoolMembership(m.routeId, m.modelId, targetGroup, 'add');
            },
          }, [
            el('option', { value: '', text: '+ Havuza ekle' }),
            ...addablePools.map(p => el('option', { value: p.id, text: p.label || p.id })),
          ])
        : null;

      listWrap.appendChild(el('div', { className: `pool-mgmt-row${selected ? ' selected' : ''}` }, [
        el('div', { className: 'model-row-text', style: 'flex:1;min-width:160px' }, [
          el('div', { className: 'msg-model-stack' }, [
            el('strong', { className: 'model-row-name', text: m.name || m.modelId }),
            m.toolLabel ? el('span', { className: 'tool-pill', text: m.toolLabel }) : null,
            subscriptionText(m) ? el('span', { className: 'sub-pill', text: subscriptionText(m) }) : null,
            ...[...memberGroups].map(g => el('span', { className: 'badge', text: state.pools.find(p => p.id === g)?.label || g })),
          ]),
          m.efforts?.length ? el('div', { className: 'model-row-sub', text: `efor: ${m.efforts.join(' · ')}` }) : null,
        ]),
        el('div', { className: 'pool-mgmt-actions' }, [
          renderInlineQuotaTags(m),
          addSelect,
          el('button', {
            type: 'button',
            className: 'mini-action-btn',
            text: selected ? '✓ Seçili' : 'Seç',
            onClick: () => {
              chooseModel({ ...m, group: [...memberGroups][0] || '' });
              switchView('chat');
              toast(`${m.name || m.modelId} seçildi.`);
            },
          }),
        ]),
      ]));
    }
    catCard.appendChild(listWrap);
    grid.appendChild(catCard);
  }

  // --- Settings View ---
  function renderSettingsView() {
    const sharedList = $('shared-folders-list');
    sharedList.replaceChildren();
    if (!state.sharedFolders.length) {
      sharedList.appendChild(el('p', { className: 'muted', text: 'Henüz paylaşılan kök eklenmemiş (tüm sürücüler ve klasörler gezilebilir).' }));
    } else {
      for (const dir of state.sharedFolders) {
        sharedList.appendChild(el('div', { className: 'device-row' }, [
          el('button', {
            type: 'button',
            className: 'chat-item-main',
            style: 'min-width:0;text-align:left',
            title: 'İçindeki klasörleri gez ve proje seç',
            onClick: () => {
              state.folderDialogPurpose = 'workspace';
              $('folder-dialog').showModal();
              void loadFolderBrowser(dir, true);
            },
          }, [
            el('strong', { text: `📁 ${folderName(dir)}` }),
            el('div', { className: 'muted mono', text: dir }),
          ]),
          el('div', { className: 'inline-btn-group' }, [
            el('button', {
              type: 'button',
              className: 'btn btn-secondary btn-sm',
              text: 'Aç',
              title: 'Alt klasörleri gez',
              onClick: () => {
                state.folderDialogPurpose = 'workspace';
                $('folder-dialog').showModal();
                void loadFolderBrowser(dir, true);
              },
            }),
            el('button', {
              type: 'button',
              className: 'btn btn-danger btn-sm',
              text: 'Kaldır',
              onClick: async () => {
                try {
                  const res = await api('/r/folders/shared', { method: 'POST', body: { action: 'remove', path: dir } });
                  state.sharedFolders = res.sharedFolders || [];
                  if (Array.isArray(res.favoriteFolders)) state.favoriteFolders = res.favoriteFolders;
                  renderSettingsView();
                  renderWorkspaceStrip();
                  renderChatList();
                  toast('Klasör paylaşımdan kaldırıldı.');
                } catch (err) { toast(err.message, true); }
              },
            }),
          ]),
        ]));
      }
    }

    const running = state.poolHealth?.status === 'ok';
    $('settings-pool-badge').className = `badge ${running ? 'badge-ok' : 'badge-danger'}`;
    $('settings-pool-badge').textContent = running ? 'Çalışıyor' : 'Kapalı';
    $('settings-pool-detail').textContent = running
      ? `Sürüm v${state.poolHealth.version || '?'} · ${state.poolHealth.connections || 0} bağlantı · ${state.poolHealth.models || 0} model · ${state.poolHealth.active || 0} aktif görev`
      : 'CLI Agent Pool arka plan servisi şu anda durdurulmuş.';

    const devList = $('devices-list');
    devList.replaceChildren();
    for (const dev of state.devices || []) {
      const isCurrent = state.device && dev.id === state.device.id;
      devList.appendChild(el('div', { className: 'device-row' }, [
        el('div', {}, [
          el('strong', { text: `${dev.label}${isCurrent ? ' (Bu cihaz)' : ''}` }),
          el('div', { className: 'muted', text: `Son kullanım: ${formatTime(dev.lastSeenAt || dev.createdAt) || '-'}` }),
        ]),
        el('button', {
          type: 'button',
          className: 'btn btn-danger btn-sm',
          text: 'İptal Et',
          onClick: async () => {
            if (!window.confirm(`"${dev.label}" cihazının erişimi iptal edilsin mi?`)) return;
            try {
              await api('/r/devices/revoke', { method: 'POST', body: { deviceId: dev.id } });
              toast('Cihaz oturumu iptal edildi.');
              await refreshState(false);
            } catch (err) { toast(err.message, true); }
          },
        }),
      ]));
    }

    $('tailscale-status-text').textContent = state.tailscaleHttpsUrl
      ? `🔒 Tailscale HTTPS aktif: ${state.tailscaleHttpsUrl} (Telefon mikrofonu ve PWA tam destekli).`
      : state.tailscaleIp
        ? `Tailscale IP algılandı: ${state.tailscaleIp} (Port: ${state.port}). Mikrofon için sağdaki "HTTPS Aç" düğmesine basın.`
        : 'Bu makinede aktif bir Tailscale IP (100.64.0.0/10) algılanmadı. Telefondan bağlanmak için bilgisayara ve telefona Tailscale kurun.';
    const httpsBtn = $('enable-https-btn');
    if (httpsBtn) httpsBtn.hidden = !state.tailscaleIp || Boolean(state.tailscaleHttpsUrl);

    const acl = { acls: [{ action: 'accept', src: ['tag:phone'], dst: [`tag:dev-pc:${state.port}`] }] };
    $('tailscale-acl-code').textContent = JSON.stringify(acl, null, 2);
  }

  // --- Antigravity-Style Model Picker (Selected Summary + Collapsible Categories + Inline Quotas) ---
  function choosePoolAuto(groupId) {
    state.selection.group = groupId || '';
    state.selection.routeId = '';
    state.selection.modelId = '';
    state.selection.modelName = '';
    state.selection.effort = '';
    state.selection.efforts = [];
    saveSelection();
    renderTopbarAndStatus();
  }

  function chooseModel(model) {
    const cleanEfforts = (Array.isArray(model.efforts) ? model.efforts : []).filter(e => e && e !== 'default');
    const candidateEffort = (model.effort && model.effort !== 'default') ? model.effort : '';
    state.selection.group = model.group || model.category || (Array.isArray(model.categories) ? model.categories[0] || '' : '');
    state.selection.routeId = model.routeId || '';
    state.selection.modelId = model.modelId || '';
    state.selection.modelName = model.name || model.modelId || '';
    state.selection.efforts = cleanEfforts;
    state.selection.effort = candidateEffort || (cleanEfforts.includes(state.selection.effort) ? state.selection.effort : '');
    saveSelection();
    renderTopbarAndStatus();
  }

  function renderSelectedSummaryInPicker() {
    const box = $('picker-selected-summary');
    box.replaceChildren();
    const sel = state.selection;
    const poolLabel = state.pools.find(p => p.id === sel.group)?.label || sel.group || 'Otomatik';
    const found = findModelObj(sel.routeId, sel.modelId);
    const left = el('div', { className: 'picker-selected-left' }, [
      el('strong', { text: '✓ Seçili:' }),
      el('span', { className: 'badge', text: poolLabel }),
      el('strong', { text: found?.name || sel.modelName || 'Havuzdan otomatik' }),
      sel.effort ? el('span', { className: 'badge', text: sel.effort }) : null,
      found?.toolLabel ? el('span', { className: 'tool-pill', text: found.toolLabel }) : null,
      found && subscriptionText(found) ? el('span', { className: 'sub-pill', text: subscriptionText(found) }) : null,
    ]);
    box.appendChild(left);
    if (found) box.appendChild(renderInlineQuotaTags(found));
  }

  function renderModelPicker() {
    renderSelectedSummaryInPicker();
    const body = $('picker-groups-list');
    body.replaceChildren();
    const q = state.pickerQuery.trim().toLowerCase();

    const matchesSearch = m => !q || [m.name, m.modelId, m.routeId, m.toolLabel, m.email, m.account, m.billing].some(s => String(s || '').toLowerCase().includes(q));

    const buildModelRow = (m, poolId) => {
      const isSelected = state.selection.modelId === m.modelId && state.selection.routeId === m.routeId;
      const efforts = (Array.isArray(m.efforts) ? m.efforts : []).filter(e => e && e !== 'default');
      const wrap = el('div', { className: 'model-row-wrap' });
      const subParts = [m.toolLabel, subscriptionText(m)].filter(Boolean).join(' · ');

      wrap.appendChild(el('button', {
        type: 'button',
        className: `model-row${isSelected ? ' selected' : ''}`,
        onClick: () => {
          chooseModel({ ...m, group: poolId || m.category || m.categories?.[0] || '' });
          renderModelPicker();
          if (!efforts.length) $('model-dialog').close();
        },
      }, [
        el('div', { className: 'model-row-left' }, [
          el('span', { className: 'model-check', text: isSelected ? '✓' : '' }),
          el('div', { className: 'model-row-text' }, [
            el('div', { className: 'model-row-name', text: m.name || m.modelId }),
            el('div', { className: 'model-row-sub', text: subParts || m.routeId }),
          ]),
        ]),
        renderInlineQuotaTags(m),
      ]));

      if (isSelected && efforts.length) {
        const effRow = el('div', { className: 'effort-inline-row' }, [
          el('span', { className: 'effort-inline-label', text: 'Efor:' }),
        ]);
        effRow.appendChild(el('button', {
          type: 'button',
          className: `effort-pill${!state.selection.effort ? ' active' : ''}`,
          text: 'Varsayılan',
          onClick: () => {
            state.selection.effort = '';
            saveSelection();
            renderTopbarAndStatus();
            $('model-dialog').close();
          },
        }));
        for (const eff of efforts) {
          effRow.appendChild(el('button', {
            type: 'button',
            className: `effort-pill${state.selection.effort === eff ? ' active' : ''}`,
            text: eff,
            onClick: () => {
              state.selection.effort = eff;
              saveSelection();
              renderTopbarAndStatus();
              $('model-dialog').close();
            },
          }));
        }
        wrap.appendChild(effRow);
      }
      return wrap;
    };

    // Collapsible categories (remembered in localStorage)
    let totalRendered = 0;
    for (const pool of state.pools) {
      const filtered = (pool.models || []).filter(matchesSearch);
      if (q && !filtered.length) continue;
      const isPoolAutoSelected = !state.selection.modelId && state.selection.group === pool.id;
      const isCollapsed = !q && state.collapsedPools.has(pool.id);

      const block = el('div', { className: 'picker-cat-block' }, [
        el('div', { className: 'picker-cat-head' }, [
          el('button', {
            type: 'button',
            className: 'picker-cat-toggle',
            'aria-expanded': String(!isCollapsed),
            onClick: () => {
              togglePoolCollapsed(pool.id);
              renderModelPicker();
            },
          }, [
            el('span', { className: 'picker-cat-chevron', text: isCollapsed ? '▸' : '▾' }),
            el('span', { text: `${pool.label || pool.id} (${filtered.length})` }),
          ]),
          el('button', {
            type: 'button',
            className: `picker-cat-auto${isPoolAutoSelected ? ' selected' : ''}`,
            text: isPoolAutoSelected ? '✓ Otomatik' : 'Otomatik',
            onClick: () => {
              choosePoolAuto(pool.id);
              $('model-dialog').close();
            },
          }),
        ]),
      ]);

      if (!isCollapsed) {
        for (const m of filtered) {
          block.appendChild(buildModelRow(m, pool.id));
          totalRendered++;
        }
      }
      body.appendChild(block);
    }

    if (q) {
      const seen = new Set(state.pools.flatMap(p => (p.models || []).map(m => `${m.routeId}::${m.modelId}`)));
      const extras = state.models.filter(m => !seen.has(`${m.routeId}::${m.modelId}`) && matchesSearch(m));
      if (extras.length) {
        const block = el('div', { className: 'picker-cat-block' }, [
          el('div', { className: 'picker-cat-head' }, [
            el('span', { className: 'picker-cat-title', text: `Diğer Katalog (${extras.length})` }),
          ]),
        ]);
        for (const m of extras) {
          block.appendChild(buildModelRow(m, ''));
          totalRendered++;
        }
        body.appendChild(block);
      }
    }

    if (!totalRendered && !state.pools.length) {
      body.appendChild(el('p', { className: 'muted', text: 'Havuz modeli bulunamadı veya servis kapalı.' }));
    }
  }

  // --- Folder Browser Dialog & Native Windows Picker ---
  async function loadFolderBrowser(targetPath = '', browseAll = false) {
    try {
      const qs = new URLSearchParams();
      if (targetPath) qs.set('path', targetPath);
      if (browseAll) qs.set('browseAll', '1');
      const data = await api(`/r/dirs?${qs.toString()}`);
      state.folderBrowser = data;
      renderFolderBrowser();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderFolderBrowser() {
    const fb = state.folderBrowser;
    const isSharedMode = state.folderDialogPurpose === 'shared';
    $('folder-dialog-title').textContent = isSharedMode ? 'Paylaşılan Disk / Klasör Ekle' : 'Proje Klasörü Seç';
    $('folder-no-project-btn').hidden = isSharedMode;
    $('folder-dialog-native-pick-btn').hidden = !state.canPickNativeFolder;
    $('folder-browser-path').textContent = fb.current || 'Sürücüler & Kök klasörler';
    $('folder-up-btn').disabled = !fb.parent && !fb.current;
    $('folder-select-current-btn').disabled = !fb.current;
    $('folder-select-current-btn').textContent = fb.current
      ? (isSharedMode ? `✓ Tamam — Paylaşılanlara Ekle: ${folderName(fb.current)}` : `✓ Tamam — Bu Klasörü Seç: ${folderName(fb.current)}`)
      : (isSharedMode ? 'Önce bir disk veya klasörün içine girin' : 'Önce bir klasörün içine girin');
    const isFav = fb.current && state.favoriteFolders.includes(fb.current);
    $('folder-star-btn').textContent = isFav ? '★' : '☆';
    $('folder-star-btn').disabled = !fb.current;

    const quickDirs = [...new Set([...state.sharedFolders, ...state.favoriteFolders])]
      .filter(d => typeof d === 'string' && d && d !== '[object Object]');
    const favSec = $('folder-favorites-section');
    favSec.hidden = isSharedMode || !quickDirs.length;
    const favList = $('folder-favorites-list');
    favList.replaceChildren();
    for (const dir of quickDirs) {
      favList.appendChild(el('div', { className: 'picker-item' }, [
        el('button', {
          type: 'button',
          className: 'chat-item-main',
          title: 'İçine girmek için tıklayın',
          onClick: () => void loadFolderBrowser(dir, true),
        }, [
          el('div', { className: 'picker-item-title', text: `📁 ${folderName(dir)}` }),
          el('div', { className: 'picker-item-sub mono', text: dir }),
        ]),
        el('div', { className: 'inline-btn-group' }, [
          el('span', { className: 'chevron', 'aria-hidden': 'true', text: '›' }),
          el('button', {
            type: 'button',
            className: 'btn btn-ghost btn-sm',
            title: 'Bu klasörü listeden kaldır',
            'aria-label': `${folderName(dir)} klasörünü kaldır`,
            text: 'Kaldır',
            onClick: async () => {
              try {
                const res = await api('/r/folders/shared', { method: 'POST', body: { action: 'remove', path: dir } });
                state.sharedFolders = res.sharedFolders || [];
                if (Array.isArray(res.favoriteFolders)) state.favoriteFolders = res.favoriteFolders;
                renderFolderBrowser();
                renderSettingsView();
                renderChatList();
                toast('Klasör kaldırıldı.');
              } catch (err) { toast(err.message, true); }
            },
          }),
        ]),
      ]));
    }

    const list = $('folder-entries-list');
    list.replaceChildren();
    if (!fb.entries.length) {
      list.appendChild(el('p', { className: 'muted', text: 'Alt klasör yok — yukarıdaki Tamam düğmesiyle bu klasörü seçebilirsiniz.' }));
      return;
    }
    for (const entry of fb.entries) {
      list.appendChild(el('div', { className: 'picker-item' }, [
        el('button', {
          type: 'button',
          className: 'chat-item-main',
          title: 'İçine girmek için tıklayın',
          onClick: () => void loadFolderBrowser(entry.path, true),
        }, [
          el('div', { className: 'picker-item-title', text: `📁 ${entry.name}` }),
          el('div', { className: 'picker-item-sub mono', text: entry.path }),
        ]),
        el('span', { className: 'chevron', 'aria-hidden': 'true', text: '›' }),
      ]));
    }
  }

  async function addSharedFolder(dir, closeDialog = false) {
    const clean = typeof dir === 'string' ? dir.trim() : '';
    if (!clean) return;
    try {
      const res = await api('/r/folders/shared', { method: 'POST', body: { action: 'add', path: clean } });
      state.sharedFolders = res.sharedFolders || [];
      renderSettingsView();
      renderWorkspaceStrip();
      renderChatList();
      if (closeDialog && $('folder-dialog').open) $('folder-dialog').close();
      toast(`Paylaşılan kök eklendi: ${folderName(res.added || clean)}`);
    } catch (err) { toast(err.message, true); }
  }

  async function pickNativeFolder(forShared = false) {
    try {
      const res = await api('/r/folders/pick', { method: 'POST', body: { initialPath: state.activeChat?.workspace || '' } });
      const pickedPath = typeof res?.path === 'string' ? res.path.trim() : '';
      if (res.cancelled || !pickedPath) return;
      if (forShared) await addSharedFolder(pickedPath, true);
      else await selectWorkspace(pickedPath, true);
    } catch (err) { toast(err.message, true); }
  }

  async function selectWorkspace(dir, closeDialog = false) {
    const clean = (typeof dir === 'string' && dir.trim() !== '[object Object]') ? dir.trim() : '';
    if (!state.activeChatId) await createNewChat(clean);
    else {
      try {
        const res = await api(`/r/chats/${encodeURIComponent(state.activeChatId)}`, {
          method: 'PATCH',
          body: { workspace: clean },
        });
        state.activeChat = res.chat;
      } catch (err) {
        toast(err.message, true);
        return;
      }
    }
    if (clean && !state.recentFolders.includes(clean)) {
      state.recentFolders = [clean, ...state.recentFolders].slice(0, 12);
    }
    const listed = state.chats.find(c => c.id === state.activeChatId);
    if (listed) listed.workspace = clean;
    renderTopbarAndStatus();
    renderWorkspaceStrip();
    renderChatList();
    if (closeDialog && $('folder-dialog').open) $('folder-dialog').close();
    toast(clean ? `Proje: ${folderName(clean)}` : 'Projesiz sohbet modu');
  }

  // --- Pairing Dialog (QR) ---
  async function openPairingDialog() {
    const dlg = $('pair-dialog');
    $('pair-qr-box').replaceChildren(el('p', { className: 'muted', text: 'QR oluşturuluyor…' }));
    $('pair-url-input').value = '';
    if (!dlg.open) dlg.showModal();
    try {
      const res = await api('/r/pair', { method: 'POST', body: { label: 'Telefon', useTailscale: true } });
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(res.qrSvg, 'image/svg+xml');
      const svgEl = svgDoc.documentElement;
      $('pair-qr-box').replaceChildren(document.importNode(svgEl, true));
      $('pair-url-input').value = res.url;
      const netBadge = $('pair-net-badge');
      const guide = $('pair-guide-text');
      if (res.tailscaleHttpsUrl) {
        state.tailscaleHttpsUrl = res.tailscaleHttpsUrl;
        netBadge.className = 'badge badge-ok';
        netBadge.textContent = `🔒 Tailscale HTTPS aktif: ${res.tailscaleHttpsUrl.replace(/^https:\/\//, '')}`;
        guide.textContent = '1. Telefonda Tailscale açık olsun. 2. Kamerayla QR kodu okutup bağlantıya dokunun (güvenli HTTPS ile telefon mikrofonu ve pano tam çalışır; QR kodu yalnız okutma için 5 dk geçerlidir, eşleştikten sonra oturumunuz 1 yıl kalıcıdır). 3. "Ana ekrana ekle" ile uygulama gibi kullanın.';
      } else if (res.tailscaleIp) {
        netBadge.className = 'badge badge-ok';
        netBadge.textContent = `Tailscale aktif: ${res.tailscaleIp}`;
        guide.textContent = '1. Telefonda Tailscale açık olsun. 2. Kamerayla QR kodu okutup bağlantıya dokunun (QR kodu yalnız okutma için 5 dk geçerlidir; eşleştikten sonra oturumunuz 1 yıl kalıcıdır, ağdan düşmezsiniz). 3. "Ana ekrana ekle" ile uygulama gibi kullanın.';
      } else {
        netBadge.className = 'badge badge-warn';
        netBadge.textContent = 'Yalnız bu bilgisayar (127.0.0.1) — Tailscale algılanmadı';
        guide.textContent = 'Telefondan bağlanmak için bilgisayara ve telefona Tailscale kurun, sonra CLI Agent Remote penceresini yeniden açın; QR otomatik olarak güvenli Tailscale adresinizle üretilir.';
      }
    } catch (err) {
      $('pair-qr-box').replaceChildren(el('p', { className: 'muted', text: err.message }));
    }
  }

  // --- Task Inspector Dialog ---
  async function openTaskInspector(taskId) {
    const dlg = $('task-dialog');
    const body = $('task-dialog-body');
    body.replaceChildren(el('p', { className: 'muted', text: 'Görev yükleniyor…' }));
    if (!dlg.open) dlg.showModal();
    try {
      const { task } = await api(`/r/tasks/${encodeURIComponent(taskId)}`);
      const [label, cls] = STATE_LABELS[task.state] || [task.state || '?', 'badge'];
      const meta = findRouteMeta(task.routeId);
      const eventLines = (task.events || []).map(formatEventLine).filter(Boolean);
      body.replaceChildren(
        el('div', { className: 'card-row' }, [
          el('div', { className: 'msg-model-stack' }, [
            el('strong', { text: task.reportedModel || task.modelId || task.routeId || 'Görev' }),
            meta?.toolLabel ? el('span', { className: 'tool-pill', text: meta.toolLabel }) : null,
            meta && subscriptionText({ ...meta, routeId: task.routeId }) ? el('span', { className: 'sub-pill', text: subscriptionText({ ...meta, routeId: task.routeId }) }) : null,
          ]),
          el('span', { className: `badge ${cls}`, text: label }),
        ]),
        el('div', { className: 'muted mono', text: `ID: ${task.id}` }),
        task.workspace ? el('div', { className: 'muted mono', text: `Klasör: ${task.workspace}` }) : null,
        task.error ? el('div', { className: 'error-box', text: cleanErrorMessage(task.errorDetail || task.error) }) : null,
        task.result ? el('div', {}, [el('div', { className: 'sub-label', text: 'Yanıt' }), renderMarkdown(task.result)]) : null,
        eventLines.length ? el('div', {}, [
          el('div', { className: 'sub-label', text: `Adımlar & olaylar (${eventLines.length})` }),
          el('pre', { className: 'code-block', text: eventLines.join('\n') }),
        ]) : null,
      );
    } catch (err) {
      body.replaceChildren(el('div', { className: 'error-box', text: err.message }));
    }
  }

  // --- Chats & Live SSE Streaming ---
  function closeAllStreams() {
    for (const es of state.streams.values()) es.close();
    state.streams.clear();
  }

  function watchTask(chatId, taskId) {
    if (!taskId || state.streams.has(taskId)) return;
    const es = new EventSource(`/r/stream?taskId=${encodeURIComponent(taskId)}&chatId=${encodeURIComponent(chatId)}`);
    state.streams.set(taskId, es);

    const applyUpdate = payload => {
      const task = payload?.task;
      if (!task || !state.activeChat || state.activeChat.id !== chatId) return;
      const msg = state.activeChat.messages.find(m => m.role === 'assistant' && m.taskId === taskId);
      if (msg) {
        msg.state = task.state;
        msg.queueReason = task.queueReason || null;
        msg.blockedBy = task.blockedBy || null;
        msg.result = task.result || '';
        msg.error = task.error || null;
        msg.errorDetail = task.errorDetail || '';
        msg.report = task.report || null;
        msg.reportedModel = task.reportedModel || msg.reportedModel;
        msg.events = (task.events || []).slice(-30);
        renderMessages(true);
      }
    };

    es.addEventListener('update', e => {
      try { applyUpdate(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    es.addEventListener('done', e => {
      try { applyUpdate(JSON.parse(e.data)); } catch { /* ignore */ }
      es.close();
      state.streams.delete(taskId);
      void refreshState(false);
    });
    es.addEventListener('error', () => {
      es.close();
      state.streams.delete(taskId);
    });
  }

  async function openChat(chatId) {
    closeAllStreams();
    state.activeChatId = chatId;
    renderChatList();
    try {
      const { chat } = await api(`/r/chats/${encodeURIComponent(chatId)}`);
      state.activeChat = chat;
      renderTopbarAndStatus();
      renderWorkspaceStrip();
      renderMessages(true);
      for (const msg of chat.messages || []) {
        if (msg.role === 'assistant' && msg.taskId && !TERMINAL_STATES.has(msg.state)) {
          watchTask(chat.id, msg.taskId);
        }
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function createNewChat(preferredWorkspace = undefined) {
    const ws = preferredWorkspace !== undefined ? preferredWorkspace : (state.activeChat?.workspace || '');
    try {
      const { chat } = await api('/r/chats', { method: 'POST', body: { workspace: ws } });
      state.chats = [{ id: chat.id, title: chat.title, workspace: chat.workspace, updatedAt: chat.updatedAt, messageCount: 0 }, ...state.chats];
      state.activeChatId = chat.id;
      state.activeChat = chat;
      renderTopbarAndStatus();
      renderChatList();
      renderWorkspaceStrip();
      renderMessages(false);
      $('prompt-input').focus();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function sendPrompt(event) {
    event.preventDefault();
    if (state.sending) return;
    const input = $('prompt-input');
    const text = input.value.trim();
    const attachments = [...state.pendingAttachments];
    if (!text && !attachments.length) return;

    if (state.poolHealth?.status !== 'ok') {
      toast('CLI Agent Pool servisi kapalı. Önce servisi başlatın.', true);
      return;
    }
    if (!state.activeChatId) await createNewChat('');
    const workspace = state.activeChat?.workspace || '';
    const modelObj = findModelObj(state.selection.routeId, state.selection.modelId);
    const modelKinds = Array.isArray(modelObj?.kinds) ? modelObj.kinds : ['text', 'read', 'write'];
    const kind = !workspace
      ? 'text'
      : (modelKinds.includes('write') ? 'write' : modelKinds.includes('read') ? 'read' : 'text');
    const cleanEffort = state.selection.effort && state.selection.effort !== 'default' ? state.selection.effort : '';

    state.sending = true;
    updateSendButton();
    try {
      const res = await api(`/r/chats/${encodeURIComponent(state.activeChatId)}/send`, {
        method: 'POST',
        body: {
          prompt: text,
          attachments,
          workspace,
          kind,
          ...(!workspace ? { mode: 'response' } : {}),
          includeContext: state.selection.includeContext,
          ...(state.selection.group ? { group: state.selection.group } : {}),
          ...(state.selection.routeId ? { routeId: state.selection.routeId } : {}),
          ...(state.selection.modelId ? { modelId: state.selection.modelId } : {}),
          ...(cleanEffort ? { effort: cleanEffort } : {}),
        },
      });
      input.value = '';
      state.pendingAttachments = [];
      renderAttachmentsStrip();
      state.activeChat = res.chat;
      renderTopbarAndStatus();
      renderMessages(true);
      if (res.task?.id) watchTask(res.chat.id, res.task.id);
      void refreshState(false);
    } catch (err) {
      toast(cleanErrorMessage(err.message), true);
    } finally {
      state.sending = false;
      updateSendButton();
    }
  }

  // --- Mobile-Fixed Voice Dictation ---
  function toggleVoiceDictation() {
    const input = $('prompt-input');
    if (!window.isSecureContext) {
      input.focus();
      toast(
        state.tailscaleHttpsUrl
          ? `Mikrofon için güvenli HTTPS adresini açın: ${state.tailscaleHttpsUrl} (veya yeni QR okutun).`
          : 'HTTP bağlantıda tarayıcı mikrofonu kısıtlıdır. Ayarlar → "HTTPS Aç" ile güvenli bağlantıyı etkinleştirin.',
        true,
      );
      return;
    }
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      input.focus();
      toast('Bu tarayıcı Web Speech desteklemiyor. Telefon klavyenizdeki mikrofon tuşuna dokunun.', true);
      return;
    }
    if (state.recording && state.recognition) {
      state.recognition.stop();
      return;
    }
    const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
    const rec = new SpeechRec();
    rec.lang = 'tr-TR';
    rec.continuous = !isMobile;
    rec.interimResults = true;
    const prefix = input.value ? `${input.value.trimEnd()} ` : '';
    let finalized = '';

    rec.onstart = () => {
      state.recording = true;
      state.recognition = rec;
      $('mic-btn').classList.add('recording');
      $('mic-status').hidden = false;
    };
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const piece = e.results[i][0]?.transcript || '';
        if (e.results[i].isFinal) finalized += `${piece} `;
        else interim += piece;
      }
      input.value = `${prefix}${finalized}${interim}`.trimStart();
      updateSendButton();
    };
    rec.onerror = e => {
      const msg = e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Mikrofon izni kapalı. Telefon klavye mikrofonunu kullanabilir veya tarayıcı izinlerini açabilirsiniz.'
        : e.error === 'no-speech' ? 'Ses algılanmadı.' : `Ses hatası: ${e.error}`;
      toast(msg, true);
    };
    rec.onend = () => {
      state.recording = false;
      state.recognition = null;
      $('mic-btn').classList.remove('recording');
      $('mic-status').hidden = true;
      updateSendButton();
    };
    try { rec.start(); } catch (err) { toast(err.message, true); }
  }

  // --- Main State Refresh ---
  async function refreshState(openInitialChat = false) {
    try {
      const data = await api('/r/state');
      state.remoteVersion = data.remoteVersion || '';
      state.device = data.device || null;
      state.poolHealth = data.poolHealth || state.poolHealth;
      state.pools = data.pools || [];
      state.models = data.models || [];
      state.quotas = data.quotas || [];
      state.connections = data.connections || [];
      state.tasks = data.tasks || [];
      state.chats = data.chats || [];
      state.sharedFolders = data.sharedFolders || [];
      state.favoriteFolders = data.favoriteFolders || [];
      state.recentFolders = data.recentFolders || [];
      state.workspaceRoots = data.workspaceRoots || [];
      state.canPickNativeFolder = Boolean(data.canPickNativeFolder);
      state.devices = data.devices || [];
      state.tailscaleIp = data.tailscaleIp || null;
      state.tailscaleHttpsUrl = data.tailscaleHttpsUrl || null;
      state.port = data.port || 43128;
      state.hostMode = data.hostMode || '127.0.0.1';

      renderTopbarAndStatus();
      renderChatList();
      renderWorkspaceStrip();
      if (state.view === 'calls') renderCallsView();
      if (state.view === 'pools') renderPoolsView();
      if (state.view === 'settings') renderSettingsView();
      if ($('quotas-dialog').open) renderQuotaCardsInto($('quotas-dialog-body'));

      if (openInitialChat) {
        if (state.chats.length) await openChat(state.chats[0].id);
        else await createNewChat('');
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // --- Wire Events ---
  function bindEvents() {
    document.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    $('topbar-back-btn').addEventListener('click', () => switchView('chat'));
    $('topbar-settings-btn').addEventListener('click', () => switchView(state.view === 'settings' ? 'chat' : 'settings'));
    $('quick-pool-btn').addEventListener('click', () => openQuotasOverlay());

    $('new-chat-btn').addEventListener('click', () => { switchView('chat'); void createNewChat(); });
    $('mobile-new-chat-btn').addEventListener('click', () => { switchView('chat'); void createNewChat(); });
    $('quick-new-chat-btn').addEventListener('click', () => { switchView('chat'); void createNewChat(); });

    // Antigravity-style Model Picker + In-Chat Quotas Overlay
    $('model-pill-btn').addEventListener('click', () => {
      state.pickerQuery = '';
      $('model-search-input').value = '';
      renderModelPicker();
      $('model-dialog').showModal();
    });
    $('model-search-input').addEventListener('input', e => {
      state.pickerQuery = e.target.value;
      renderModelPicker();
    });
    $('picker-view-quotas-btn').addEventListener('click', () => {
      $('model-dialog').close();
      openQuotasOverlay();
    });
    $('quotas-dialog-refresh-btn').addEventListener('click', async () => {
      toast('Canlı kotalar sorgulanıyor…');
      try {
        await api('/r/quotas/refresh', { method: 'POST', body: {} });
        await refreshState(false);
        toast('Kotalar güncellendi.');
      } catch (err) { toast(err.message, true); }
    });

    // Document Attachment, Drag/Drop & Paste
    $('attach-doc-btn').addEventListener('click', () => $('doc-file-input').click());
    $('doc-file-input').addEventListener('change', e => {
      void addFilesAsAttachments(e.target.files);
      e.target.value = '';
    });
    const composerCard = $('composer-card');
    composerCard.addEventListener('dragover', e => { e.preventDefault(); composerCard.classList.add('drag-over'); });
    composerCard.addEventListener('dragleave', () => composerCard.classList.remove('drag-over'));
    composerCard.addEventListener('drop', e => {
      e.preventDefault();
      composerCard.classList.remove('drag-over');
      if (e.dataTransfer?.files?.length) void addFilesAsAttachments(e.dataTransfer.files);
    });
    $('prompt-input').addEventListener('paste', e => {
      const files = e.clipboardData?.files;
      if (files && files.length) {
        e.preventDefault();
        void addFilesAsAttachments(files);
      }
    });

    // Document Viewer Dialog actions
    $('doc-copy-btn').addEventListener('click', async () => {
      try { await copyText(state.activeDoc.content); toast('Doküman kopyalandı.'); }
      catch { toast('Kopyalanamadı.', true); }
    });
    $('doc-download-btn').addEventListener('click', () => downloadTextFile(state.activeDoc.name, state.activeDoc.content));

    // Folder Picker & Shared Folders (drives + folders + subfolders)
    $('folder-picker-btn').addEventListener('click', () => {
      state.folderDialogPurpose = 'workspace';
      $('folder-dialog').showModal();
      void loadFolderBrowser(state.activeChat?.workspace || '');
    });
    $('folder-no-project-btn').addEventListener('click', () => void selectWorkspace('', true));
    $('folder-dialog-native-pick-btn').addEventListener('click', () => void pickNativeFolder(state.folderDialogPurpose === 'shared'));
    $('folder-up-btn').addEventListener('click', () => void loadFolderBrowser(state.folderBrowser.parent || '', state.folderDialogPurpose === 'shared' || !state.folderBrowser.restricted));
    $('folder-select-current-btn').addEventListener('click', () => {
      if (state.folderDialogPurpose === 'shared') void addSharedFolder(state.folderBrowser.current, true);
      else void selectWorkspace(state.folderBrowser.current, true);
    });
    $('folder-star-btn').addEventListener('click', async () => {
      if (!state.folderBrowser.current) return;
      try {
        const res = await api('/r/folders/favorite', { method: 'POST', body: { path: state.folderBrowser.current } });
        state.favoriteFolders = res.favoriteFolders || [];
        renderFolderBrowser();
        renderWorkspaceStrip();
      } catch (err) { toast(err.message, true); }
    });

    // Single unified "📁 Klasör Seç" button in Settings:
    // Opens the interactive folder & drive browser immediately (works on desktop and phone,
    // and includes the native Windows dialog button inside the sheet).
    $('add-shared-folder-btn').addEventListener('click', () => {
      state.folderDialogPurpose = 'shared';
      $('folder-dialog').showModal();
      void loadFolderBrowser('', true);
    });

    $('context-toggle-btn').addEventListener('click', () => {
      state.selection.includeContext = !state.selection.includeContext;
      saveSelection();
      renderTopbarAndStatus();
    });

    document.querySelectorAll('.quick-prompt-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        $('prompt-input').value = btn.dataset.prompt || '';
        updateSendButton();
        $('prompt-input').focus();
      });
    });

    // IME-safe Enter submit (ime-safe-enter-submit)
    const composerForm = $('composer-form');
    const promptInput = $('prompt-input');
    composerForm.addEventListener('submit', sendPrompt);
    promptInput.addEventListener('input', updateSendButton);
    promptInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      if (!state.sending && (promptInput.value.trim() || state.pendingAttachments.length)) composerForm.requestSubmit();
    });

    $('mic-btn').addEventListener('click', toggleVoiceDictation);

    // Calls actions
    $('refresh-calls-btn').addEventListener('click', () => void refreshState(false));
    $('clear-calls-btn').addEventListener('click', async () => {
      if (!window.confirm('Tamamlanmış çağrı geçmişi temizlensin mi?')) return;
      try {
        await api('/r/tasks/clear', { method: 'POST', body: {} });
        toast('Çağrı geçmişi temizlendi.');
        await refreshState(false);
      } catch (err) { toast(err.message, true); }
    });

    // Pools / Catalog / Quotas sub-tabs & search
    document.querySelectorAll('[data-pool-subtab]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.poolSubtab = btn.dataset.poolSubtab;
        renderPoolsView();
      });
    });
    $('pools-search-input').addEventListener('input', e => {
      state.poolsSearch = e.target.value;
      renderPoolsView();
    });
    $('refresh-quotas-btn').addEventListener('click', async () => {
      toast('Canlı kotalar sorgulanıyor…');
      try {
        await api('/r/quotas/refresh', { method: 'POST', body: {} });
        await refreshState(false);
        toast('Kotalar güncellendi.');
      } catch (err) { toast(err.message, true); }
    });

    document.querySelectorAll('[data-theme]').forEach(btn => {
      btn.addEventListener('click', () => applyTheme(btn.dataset.theme, true));
    });

    const startPool = async () => {
      toast('CLI Agent Pool başlatılıyor…');
      try {
        await api('/r/pool/start', { method: 'POST', body: {} });
        await refreshState(false);
        toast('CLI Agent Pool başlatıldı.');
      } catch (err) { toast(err.message, true); }
    };
    $('pool-start-btn').addEventListener('click', startPool);
    $('banner-start-pool-btn').addEventListener('click', startPool);

    $('pool-restart-btn').addEventListener('click', async () => {
      try {
        const res = await api('/r/pool/restart', { method: 'POST', body: {} });
        if (res.confirmRequired) toast(res.message || 'Aktif görev var, yeniden başlatma ertelendi.', true);
        else {
          toast('Servis yeniden başlatılıyor…');
          setTimeout(() => void refreshState(false), 2500);
        }
      } catch (err) { toast(err.message, true); }
    });

    $('pool-stop-btn').addEventListener('click', async () => {
      try {
        const res = await api('/r/pool/stop', { method: 'POST', body: { force: false } });
        if (res.confirmRequired) {
          if (window.confirm(`${res.activeCount} aktif görev çalışıyor. Yine de zorla durdurulsun mu?`)) {
            await api('/r/pool/stop', { method: 'POST', body: { force: true } });
            toast('Servis durduruldu.');
          }
        } else {
          toast('Servis durduruldu.');
        }
        await refreshState(false);
      } catch (err) { toast(err.message, true); }
    });

    $('open-pair-sidebar-btn').addEventListener('click', () => void openPairingDialog());
    $('open-pair-settings-btn').addEventListener('click', () => void openPairingDialog());
    $('regen-pair-btn').addEventListener('click', () => void openPairingDialog());
    $('copy-pair-url-btn').addEventListener('click', async () => {
      try { await copyText($('pair-url-input').value); toast('Eşleştirme bağlantısı kopyalandı.'); }
      catch { toast('Kopyalanamadı', true); }
    });
    $('copy-acl-btn').addEventListener('click', async () => {
      try { await copyText($('tailscale-acl-code').textContent); toast('Tailscale ACL kopyalandı.'); }
      catch { toast('Kopyalanamadı', true); }
    });
    $('enable-https-btn')?.addEventListener('click', async () => {
      toast('Tailscale HTTPS tüneli açılıyor…');
      try {
        const res = await api('/r/tailscale/https', { method: 'POST', body: {} });
        state.tailscaleHttpsUrl = res.tailscaleHttpsUrl || null;
        renderSettingsView();
        toast(`HTTPS aktif: ${state.tailscaleHttpsUrl}`);
      } catch (err) { toast(err.message, true); }
    });
  }

  // --- Boot ---
  applyTheme(readSavedTheme(), false);
  loadPreferences();
  initDialogLightDismiss();
  initMobileBackNavigation();
  bindEvents();
  updateSendButton();
  void refreshState(true);
  setInterval(() => {
    if (!document.hidden) void refreshState(false);
  }, 15_000);
})();
