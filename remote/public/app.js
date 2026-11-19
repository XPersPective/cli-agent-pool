(() => {
  'use strict';

  const THEME_KEY = 'remote-color-scheme';
  const SELECTION_KEY = 'remote-selection';
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
    pickerQuery: '',
    folderBrowser: { current: '', parent: '', entries: [], restricted: false, canBrowseAll: false },
    folderDialogPurpose: 'workspace', // 'workspace' | 'shared'
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

  // --- Selection Persistence ---
  function loadSelection() {
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
  }

  function saveSelection() {
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify(state.selection)); } catch { /* ignore */ }
  }

  function folderName(p) {
    if (!p) return 'Projesiz';
    const clean = String(p).replace(/[\\/]+$/, '');
    const parts = clean.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : clean;
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  function renderInlineQuotaTags(model) {
    const wrap = el('span', { className: 'model-quotas-inline' });
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

  // --- Send Button Auto-Disable State ---
  function updateSendButton() {
    const btn = $('send-btn');
    const input = $('prompt-input');
    if (!btn || !input) return;
    const hasText = input.value.trim().length > 0;
    btn.disabled = state.sending || !hasText;
    btn.classList.toggle('sending', state.sending);
    btn.setAttribute('aria-busy', String(state.sending));
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
        const copyBtn = el('button', {
          type: 'button',
          className: 'code-copy-btn',
          text: 'Kopyala',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(code);
              copyBtn.textContent = 'Kopyalandı';
              setTimeout(() => { copyBtn.textContent = 'Kopyala'; }, 1500);
            } catch { toast('Kopyalanamadı', true); }
          },
        });
        root.appendChild(el('div', { className: 'code-card' }, [
          el('div', { className: 'code-card-head' }, [
            el('span', { text: lang || 'kod' }),
            copyBtn,
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

  // --- View Switching ---
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    document.querySelectorAll('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    if (view === 'chats') renderChatGroups($('mobile-chat-list'), true);
    if (view === 'calls' || view === 'pools' || view === 'settings') void refreshState(false);
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

    // Topbar chat title & project subtitle
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
    $('clear-folder-btn').hidden = !ws;

    const chips = $('folder-chips');
    chips.replaceChildren();
    const combined = [...new Set([...state.sharedFolders, ...state.favoriteFolders, ...state.recentFolders])]
      .filter(dir => dir && dir !== ws)
      .slice(0, 5);
    for (const dir of combined) {
      chips.appendChild(el('button', {
        type: 'button',
        className: 'folder-chip',
        title: dir,
        text: `📁 ${folderName(dir)}`,
        onClick: () => void selectWorkspace(dir),
      }));
    }
  }

  // --- Grouped Chats by Project Folder (Sidebar + Mobile Chats View) ---
  function renderChatGroups(container, isMobileView = false) {
    if (!container) return;
    container.replaceChildren();

    const groups = new Map();
    groups.set('', []); // Projesiz sohbetler always first
    for (const dir of [...state.sharedFolders, ...state.favoriteFolders]) {
      if (dir && !groups.has(dir)) groups.set(dir, []);
    }
    for (const chat of state.chats) {
      const key = chat.workspace || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(chat);
    }

    for (const [folderPath, chats] of groups.entries()) {
      if (!chats.length && folderPath === '' && groups.size > 1) {
        // Keep Projesiz header visible so user can 1-tap start a projectless chat
      }
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

  function renderAssistantBubble(msg) {
    const [stateLabel, stateCls] = STATE_LABELS[msg.state] || [msg.state || 'Bekliyor', 'badge'];
    const isActive = msg.taskId && !TERMINAL_STATES.has(msg.state);

    const statusBadge = el('span', { className: `badge ${stateCls}` }, [
      isActive ? el('span', { className: 'pulse-dot' }) : null,
      stateLabel,
    ]);

    const headRight = el('div', { className: 'topbar-right' }, [
      statusBadge,
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
        el('div', { className: 'msg-model-tag' }, [
          el('span', { text: modelText }),
          msg.kind === 'text' ? el('span', { className: 'badge', text: 'Sohbet' }) : el('span', { className: 'badge', text: 'Proje' }),
        ]),
        headRight,
      ]),
    ];

    if (msg.error) {
      const cleanErr = cleanErrorMessage(msg.errorDetail || msg.error);
      bodyNodes.push(el('div', { className: 'error-box', text: cleanErr }));
    }

    const outputText = msg.result || msg.text || '';
    if (outputText) {
      bodyNodes.push(renderMarkdown(outputText));
    } else if (isActive) {
      bodyNodes.push(el('p', { className: 'muted', text: 'Ajan çalışıyor, adımlar canlı olarak izleniyor…' }));
    }

    if (msg.report && (msg.report.summary || msg.report.files?.length)) {
      const reportChildren = [];
      if (msg.report.summary && msg.report.summary !== outputText) {
        reportChildren.push(el('div', { text: msg.report.summary }));
      }
      if (Array.isArray(msg.report.files) && msg.report.files.length) {
        reportChildren.push(el('div', { className: 'report-files' }, msg.report.files.slice(0, 16).map(f =>
          el('span', { className: 'file-pill', text: `${f.status ? `${f.status} ` : ''}${f.path || f}` }),
        )));
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

    return el('article', { className: 'msg msg-assistant' }, [
      el('div', { className: 'msg-bubble' }, bodyNodes),
      el('div', { className: 'msg-meta', text: [msg.routeId, formatTime(msg.at)].filter(Boolean).join(' · ') }),
    ]);
  }

  function renderMessages(scrollToBottom = false) {
    const messages = state.activeChat?.messages || [];
    $('empty-chat-state').hidden = messages.length > 0;
    const list = $('messages-list');
    list.replaceChildren();

    for (const msg of messages) {
      if (msg.role === 'user') {
        list.appendChild(el('article', { className: 'msg msg-user' }, [
          el('div', { className: 'msg-bubble', text: msg.text || '' }),
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
      container.appendChild(el('div', { className: 'panel-card' }, [
        el('div', { className: 'card-row' }, [
          el('div', {}, [
            el('h3', { text: task.reportedModel || task.modelId || task.routeId || 'Görev' }),
            el('p', { className: 'muted', text: `${task.workspace ? folderName(task.workspace) : 'Sohbet'}${task.clientLabel ? ` · ${task.clientLabel}` : ''}` }),
          ]),
          el('span', { className: `badge ${cls}` }, [active ? el('span', { className: 'pulse-dot' }) : null, label]),
        ]),
        task.result ? el('p', { className: 'muted', text: String(task.result).slice(0, 180) }) : null,
        task.error ? el('div', { className: 'error-box', text: cleanErrorMessage(task.errorDetail || task.error) }) : null,
        el('div', { className: 'btn-row' }, [
          el('button', { type: 'button', className: 'btn btn-secondary btn-sm', text: 'İncele', onClick: () => void openTaskInspector(task.id) }),
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
          }) : null,
        ]),
      ]));
    }
  }

  function renderPoolsView() {
    const qStrip = $('quotas-summary');
    qStrip.replaceChildren();
    for (const q of state.quotas || []) {
      const pct = Number.isFinite(q.remainingPercent) ? Math.round(q.remainingPercent) : null;
      const fillCls = pct == null ? '' : pct <= 10 ? ' danger' : pct <= 30 ? ' warn' : '';
      const winsRow = Array.isArray(q.windows) && q.windows.length
        ? el('div', { className: 'quota-win-row' }, q.windows.slice(0, 4).map(w => {
            const wp = Math.round(w.remainingPercent);
            const cls = wp <= 10 ? 'q-tag danger' : wp <= 30 ? 'q-tag warn' : 'q-tag';
            return el('span', { className: cls }, [`${w.name.split(':').pop() || w.name} `, el('strong', { text: `%${wp}` })]);
          }))
        : null;
      qStrip.appendChild(el('div', { className: 'quota-card' }, [
        el('div', { className: 'card-row' }, [
          el('strong', { text: q.routeId || q.adapter || 'Bağlantı' }),
          pct != null ? el('span', { className: 'badge', text: `%${pct}` }) : el('span', { className: 'badge', text: q.status || '?' }),
        ]),
        el('div', { className: 'muted', text: `${q.adapter || ''} · ${q.billing || ''} · ${q.models || 0} model` }),
        pct != null ? el('div', { className: 'quota-bar' }, el('div', { className: `quota-fill${fillCls}`, style: `width:${Math.max(0, Math.min(100, pct))}%` })) : null,
        winsRow,
      ]));
    }

    const grid = $('pools-grid');
    grid.replaceChildren();
    if (!state.pools.length) {
      grid.appendChild(el('div', { className: 'panel-card' }, el('p', { className: 'muted', text: 'Havuz bulunamadı veya servis kapalı.' })));
      return;
    }

    for (const pool of state.pools) {
      const models = pool.models || [];
      const items = models.map(m => el('button', {
        type: 'button',
        className: `model-row${state.selection.modelId === m.modelId && state.selection.routeId === m.routeId ? ' selected' : ''}`,
        onClick: () => {
          chooseModel({ ...m, group: pool.id });
          switchView('chat');
          toast(`${m.name || m.modelId} seçildi.`);
        },
      }, [
        el('div', { className: 'model-row-left' }, [
          el('span', { className: 'model-check', text: (state.selection.modelId === m.modelId && state.selection.routeId === m.routeId) ? '✓' : '' }),
          el('div', { className: 'model-row-text' }, [
            el('div', { className: 'model-row-name', text: m.name || m.modelId }),
            el('div', { className: 'model-row-sub', text: [m.routeId, m.effort ? `efor: ${m.effort}` : ''].filter(Boolean).join(' · ') }),
          ]),
        ]),
        renderInlineQuotaTags(m),
      ]));

      grid.appendChild(el('div', { className: 'panel-card' }, [
        el('div', { className: 'card-row' }, [
          el('div', {}, [
            el('h3', { text: pool.label || pool.id }),
            el('p', { className: 'muted', text: `${models.length} model (A→Z)` }),
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
        el('div', { className: 'picker-list', style: 'margin-top:8px' }, items.length ? items : [el('p', { className: 'muted', text: 'Bu havuzda aktif model yok.' })]),
      ]));
    }
  }

  function renderSettingsView() {
    // Shared project folders
    const sharedList = $('shared-folders-list');
    sharedList.replaceChildren();
    $('pick-native-folder-btn').hidden = !state.canPickNativeFolder;
    if (!state.sharedFolders.length) {
      sharedList.appendChild(el('p', { className: 'muted', text: 'Henüz özel paylaşılan proje klasörü eklenmemiş (tüm sürücülere gözatabilirsiniz).' }));
    } else {
      for (const dir of state.sharedFolders) {
        sharedList.appendChild(el('div', { className: 'device-row' }, [
          el('div', { style: 'min-width:0' }, [
            el('strong', { text: `📁 ${folderName(dir)}` }),
            el('div', { className: 'muted mono', text: dir }),
          ]),
          el('button', {
            type: 'button',
            className: 'btn btn-danger btn-sm',
            text: 'Kaldır',
            onClick: async () => {
              try {
                const res = await api('/r/folders/shared', { method: 'POST', body: { action: 'remove', path: dir } });
                state.sharedFolders = res.sharedFolders || [];
                renderSettingsView();
                renderWorkspaceStrip();
                renderChatList();
                toast('Klasör paylaşımdan kaldırıldı.');
              } catch (err) { toast(err.message, true); }
            },
          }),
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

    $('tailscale-status-text').textContent = state.tailscaleIp
      ? `Tailscale IP algılandı: ${state.tailscaleIp} (Port: ${state.port}). Yalnızca Tailscale arayüzünüzden ve eşleşmiş cihazlardan erişilebilir.`
      : 'Bu makinede aktif bir Tailscale IP (100.64.0.0/10) algılanmadı. Telefondan bağlanmak için bilgisayara ve telefona Tailscale kurun.';

    const acl = {
      acls: [
        {
          action: 'accept',
          src: ['tag:phone'],
          dst: [`tag:dev-pc:${state.port}`],
        },
      ],
    };
    $('tailscale-acl-code').textContent = JSON.stringify(acl, null, 2);
  }

  // --- Antigravity-Style Model & Effort Picker Dialog ---
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

  function renderModelPicker() {
    const body = $('picker-groups-list');
    body.replaceChildren();
    const q = state.pickerQuery.trim().toLowerCase();

    const matchesSearch = m => !q || [m.name, m.modelId, m.routeId, m.billing, m.account].some(s => String(s || '').toLowerCase().includes(q));

    const buildModelRow = (m, poolId) => {
      const isSelected = state.selection.modelId === m.modelId && state.selection.routeId === m.routeId;
      const efforts = (Array.isArray(m.efforts) ? m.efforts : []).filter(e => e && e !== 'default');
      const wrap = el('div', { className: 'model-row-wrap' });

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
            el('div', { className: 'model-row-sub', text: m.routeId }),
          ]),
        ]),
        renderInlineQuotaTags(m),
      ]));

      if (isSelected && efforts.length) {
        const effRow = el('div', { className: 'effort-inline-row' });
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

    // Vertical stacked categories (High, Medium, Low, custom...) — A→Z inside each
    let totalRendered = 0;
    for (const pool of state.pools) {
      const filtered = (pool.models || []).filter(matchesSearch);
      if (q && !filtered.length) continue;
      const isPoolAutoSelected = !state.selection.modelId && state.selection.group === pool.id;

      const block = el('div', { className: 'picker-cat-block' }, [
        el('div', { className: 'picker-cat-head' }, [
          el('span', { className: 'picker-cat-title', text: `${pool.label || pool.id} (${filtered.length})` }),
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

      for (const m of filtered) {
        block.appendChild(buildModelRow(m, pool.id));
        totalRendered++;
      }
      body.appendChild(block);
    }

    // If user is searching and there are catalog models outside pools, show them below
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
    $('folder-dialog-title').textContent = isSharedMode ? 'Paylaşılan Proje Klasörü Ekle' : 'Proje Klasörü Seç';
    $('folder-no-project-btn').hidden = isSharedMode;
    $('folder-dialog-native-pick-btn').hidden = !state.canPickNativeFolder;
    $('folder-browse-all-btn').hidden = !fb.canBrowseAll;
    $('folder-browser-path').textContent = fb.current || 'Kök klasörler';
    $('folder-up-btn').disabled = !fb.parent && !fb.current;
    $('folder-select-current-btn').disabled = !fb.current;
    $('folder-select-current-btn').textContent = isSharedMode ? 'Bu Klasörü Paylaşılanlara Ekle' : 'Bu Proje Klasörünü Seç';
    const isFav = fb.current && state.favoriteFolders.includes(fb.current);
    $('folder-star-btn').textContent = isFav ? '★' : '☆';
    $('folder-star-btn').disabled = !fb.current;

    const quickDirs = [...new Set([...state.sharedFolders, ...state.favoriteFolders])];
    const favSec = $('folder-favorites-section');
    favSec.hidden = isSharedMode || !quickDirs.length;
    const favList = $('folder-favorites-list');
    favList.replaceChildren();
    for (const dir of quickDirs) {
      favList.appendChild(el('button', {
        type: 'button',
        className: 'picker-item',
        onClick: () => void selectWorkspace(dir, true),
      }, [
        el('div', { className: 'picker-item-main' }, [
          el('div', { className: 'picker-item-title', text: `📁 ${folderName(dir)}` }),
          el('div', { className: 'picker-item-sub mono', text: dir }),
        ]),
      ]));
    }

    const list = $('folder-entries-list');
    list.replaceChildren();
    if (!fb.entries.length) {
      list.appendChild(el('p', { className: 'muted', text: 'Alt klasör yok.' }));
      return;
    }
    for (const entry of fb.entries) {
      list.appendChild(el('div', { className: 'picker-item' }, [
        el('button', {
          type: 'button',
          className: 'chat-item-main',
          onClick: () => void loadFolderBrowser(entry.path),
        }, [
          el('div', { className: 'picker-item-title', text: `${entry.isGit ? '📦 ' : '📁 '}${entry.name}` }),
          el('div', { className: 'picker-item-sub mono', text: entry.path }),
        ]),
        el('button', {
          type: 'button',
          className: 'btn btn-secondary btn-sm',
          text: isSharedMode ? 'Ekle' : 'Seç',
          onClick: () => isSharedMode ? void addSharedFolder(entry.path, true) : void selectWorkspace(entry.path, true),
        }),
      ]));
    }
  }

  async function addSharedFolder(dir, closeDialog = false) {
    if (!dir) return;
    try {
      const res = await api('/r/folders/shared', { method: 'POST', body: { action: 'add', path: dir } });
      state.sharedFolders = res.sharedFolders || [];
      renderSettingsView();
      renderWorkspaceStrip();
      renderChatList();
      if (closeDialog && $('folder-dialog').open) $('folder-dialog').close();
      toast(`Paylaşılan klasör eklendi: ${folderName(dir)}`);
    } catch (err) { toast(err.message, true); }
  }

  async function pickNativeFolder(forShared = false) {
    try {
      const res = await api('/r/folders/pick', { method: 'POST', body: { initialPath: state.activeChat?.workspace || '' } });
      if (res.cancelled || !res.path) return;
      if (forShared) await addSharedFolder(res.path, true);
      else await selectWorkspace(res.path, true);
    } catch (err) { toast(err.message, true); }
  }

  async function selectWorkspace(dir, closeDialog = false) {
    const clean = String(dir || '').trim();
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
      if (res.tailscaleIp) {
        netBadge.className = 'badge badge-ok';
        netBadge.textContent = `Tailscale aktif: ${res.tailscaleIp}`;
        guide.textContent = '1. Telefonda Tailscale açık olsun. 2. Telefonunuzun normal Kamera uygulamasıyla bu QR kodu okutun ve linke dokunun (otomatik giriş yapılır). 3. Tarayıcıdan "Ana ekrana ekle" diyerek uygulama gibi kullanın.';
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
      const eventLines = (task.events || []).map(formatEventLine).filter(Boolean);
      body.replaceChildren(
        el('div', { className: 'card-row' }, [
          el('strong', { text: task.reportedModel || task.modelId || task.routeId || 'Görev' }),
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
    if (!text) return;

    if (state.poolHealth?.status !== 'ok') {
      toast('CLI Agent Pool servisi kapalı. Önce servisi başlatın.', true);
      return;
    }
    if (!state.activeChatId) await createNewChat('');
    const workspace = state.activeChat?.workspace || '';
    const modelObj = findModelObj(state.selection.routeId, state.selection.modelId);
    const modelKinds = Array.isArray(modelObj?.kinds) ? modelObj.kinds : ['text', 'read', 'write'];
    const kind = workspace
      ? (modelKinds.includes('write') ? 'write' : modelKinds.includes('read') ? 'read' : 'text')
      : 'text';
    const mode = workspace && kind === 'write' ? 'execute' : 'response';
    const cleanEffort = state.selection.effort && state.selection.effort !== 'default' ? state.selection.effort : '';

    state.sending = true;
    updateSendButton();
    try {
      const res = await api(`/r/chats/${encodeURIComponent(state.activeChatId)}/send`, {
        method: 'POST',
        body: {
          prompt: text,
          workspace,
          kind,
          mode,
          includeContext: state.selection.includeContext,
          ...(state.selection.group ? { group: state.selection.group } : {}),
          ...(state.selection.routeId ? { routeId: state.selection.routeId } : {}),
          ...(state.selection.modelId ? { modelId: state.selection.modelId } : {}),
          ...(cleanEffort ? { effort: cleanEffort } : {}),
        },
      });
      input.value = '';
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

  // --- Mobile-Fixed Voice Dictation (Web Speech API) ---
  function toggleVoiceDictation() {
    const input = $('prompt-input');
    if (!window.isSecureContext) {
      input.focus();
      toast('HTTP bağlantıda tarayıcı mikrofonu kısıtlıdır. Telefon klavyesindeki mikrofonu kullanın veya "tailscale serve --bg 43128" ile HTTPS açın.', true);
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
        : e.error === 'no-speech'
          ? 'Ses algılanmadı.'
          : `Ses hatası: ${e.error}`;
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
      state.port = data.port || 43128;
      state.hostMode = data.hostMode || '127.0.0.1';

      renderTopbarAndStatus();
      renderChatList();
      renderWorkspaceStrip();
      if (state.view === 'calls') renderCallsView();
      if (state.view === 'pools') renderPoolsView();
      if (state.view === 'settings') renderSettingsView();

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

    $('topbar-settings-btn').addEventListener('click', () => switchView(state.view === 'settings' ? 'chat' : 'settings'));
    $('quick-pool-btn').addEventListener('click', () => switchView('pools'));

    $('new-chat-btn').addEventListener('click', () => {
      switchView('chat');
      void createNewChat();
    });
    $('mobile-new-chat-btn').addEventListener('click', () => {
      switchView('chat');
      void createNewChat();
    });
    $('quick-new-chat-btn').addEventListener('click', () => {
      switchView('chat');
      void createNewChat();
    });

    // Antigravity-style Model Picker
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
      switchView('pools');
    });

    // Folder Picker & Shared Folders
    $('folder-picker-btn').addEventListener('click', () => {
      state.folderDialogPurpose = 'workspace';
      $('folder-dialog').showModal();
      void loadFolderBrowser(state.activeChat?.workspace || '');
    });
    $('clear-folder-btn').addEventListener('click', () => void selectWorkspace(''));
    $('folder-no-project-btn').addEventListener('click', () => void selectWorkspace('', true));
    $('folder-dialog-native-pick-btn').addEventListener('click', () => void pickNativeFolder(state.folderDialogPurpose === 'shared'));
    $('folder-browse-all-btn').addEventListener('click', () => void loadFolderBrowser('', true));
    $('folder-up-btn').addEventListener('click', () => void loadFolderBrowser(state.folderBrowser.parent || ''));
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

    $('pick-native-folder-btn').addEventListener('click', () => void pickNativeFolder(true));
    $('browse-add-shared-btn').addEventListener('click', () => {
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

    // IME-safe Enter submit (ime-safe-enter-submit) + live send button state
    const composerForm = $('composer-form');
    const promptInput = $('prompt-input');
    composerForm.addEventListener('submit', sendPrompt);
    promptInput.addEventListener('input', updateSendButton);
    promptInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      if (!state.sending && promptInput.value.trim()) composerForm.requestSubmit();
    });

    $('mic-btn').addEventListener('click', toggleVoiceDictation);

    // Calls / Pools / Settings actions
    $('refresh-calls-btn').addEventListener('click', () => void refreshState(false));
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
        if (res.confirmRequired) {
          toast(res.message || 'Aktif görev var, yeniden başlatma ertelendi.', true);
        } else {
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
      try {
        await navigator.clipboard.writeText($('pair-url-input').value);
        toast('Eşleştirme bağlantısı kopyalandı.');
      } catch { toast('Kopyalanamadı', true); }
    });
    $('copy-acl-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('tailscale-acl-code').textContent);
        toast('Tailscale ACL kopyalandı.');
      } catch { toast('Kopyalanamadı', true); }
    });
  }

  // --- Boot ---
  applyTheme(readSavedTheme(), false);
  loadSelection();
  initDialogLightDismiss();
  bindEvents();
  updateSendButton();
  void refreshState(true);
  setInterval(() => {
    if (!document.hidden) void refreshState(false);
  }, 15_000);
})();
