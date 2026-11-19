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

  const KIND_LABELS = { text: 'Sohbet', read: 'Analiz', write: 'Kod Yaz' };

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
    favoriteFolders: [],
    recentFolders: [],
    workspaceRoots: [],
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
      kind: 'read',
      includeContext: true,
    },
    pickerTab: 'all',
    pickerQuery: '',
    folderBrowser: { current: '', parent: '', entries: [], restricted: false },
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
    state.toastTimer = setTimeout(() => { box.hidden = true; }, isError ? 4600 : 2600);
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
    if (themeMeta) themeMeta.content = isLight ? '#f5f7fb' : '#0b0d12';
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
        Object.assign(state.selection, {
          group: typeof saved.group === 'string' ? saved.group : '',
          routeId: typeof saved.routeId === 'string' ? saved.routeId : '',
          modelId: typeof saved.modelId === 'string' ? saved.modelId : '',
          modelName: typeof saved.modelName === 'string' ? saved.modelName : '',
          effort: typeof saved.effort === 'string' ? saved.effort : '',
          kind: ['text', 'read', 'write'].includes(saved.kind) ? saved.kind : 'read',
          includeContext: saved.includeContext !== false,
        });
      }
    } catch { /* ignore */ }
  }

  function saveSelection() {
    try { localStorage.setItem(SELECTION_KEY, JSON.stringify(state.selection)); } catch { /* ignore */ }
  }

  function folderName(p) {
    if (!p) return 'Klasör seç…';
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

  function quotaBadge(quota) {
    if (!quota || quota.remainingPercent == null || !Number.isFinite(quota.remainingPercent)) return null;
    const pct = Math.round(quota.remainingPercent);
    const cls = pct <= 10 ? 'badge badge-danger' : pct <= 30 ? 'badge badge-warn' : 'badge badge-ok';
    return el('span', { className: cls, text: `%${pct}` });
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

  // --- Navigation & Drawer ---
  function setDrawer(open) {
    $('sidebar').classList.toggle('open', open);
    $('drawer-backdrop').hidden = !open;
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    document.querySelectorAll('[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    setDrawer(false);
    if (view === 'calls' || view === 'pools' || view === 'settings') void refreshState(false);
  }

  // --- Rendering ---
  function renderTopbarAndStatus() {
    const running = state.poolHealth?.status === 'ok';
    const active = Number(state.poolHealth?.active || 0);
    const poolDot = $('pool-dot');
    poolDot.className = `status-dot ${running ? 'ok' : 'danger'}`;
    $('pool-chip-label').textContent = running ? (active > 0 ? `Pool (${active})` : 'Pool') : 'Kapalı';
    $('sidebar-pool-status').textContent = running
      ? `v${state.poolHealth.version || '?'} · ${state.poolHealth.models || 0} model`
      : 'Servis kapalı';

    $('pool-offline-banner').hidden = running;

    const navBadge = $('nav-active-badge');
    navBadge.hidden = active <= 0;
    navBadge.textContent = String(active);
    $('bnav-active-badge').hidden = active <= 0;

    // Model pill
    const sel = state.selection;
    const poolObj = state.pools.find(p => p.id === sel.group);
    const poolLabel = poolObj?.label || sel.group;
    let title = 'Otomatik Model';
    let meta = poolLabel ? `Havuz: ${poolLabel}` : 'En uygun havuzdan seç';
    let dotClass = running ? 'status-dot ok' : 'status-dot warn';

    if (sel.modelId) {
      const found = findModelObj(sel.routeId, sel.modelId);
      title = found?.name || sel.modelName || sel.modelId;
      const parts = [];
      if (poolLabel) parts.push(poolLabel);
      if (sel.effort) parts.push(`Efor: ${sel.effort}`);
      if (found?.quota?.remainingPercent != null) parts.push(`%${Math.round(found.quota.remainingPercent)}`);
      meta = parts.join(' · ') || sel.routeId || 'Doğrudan model';
      if (found?.quota?.remainingPercent != null && found.quota.remainingPercent <= 10) dotClass = 'status-dot danger';
    }
    $('model-pill-dot').className = dotClass;
    $('model-pill-name').textContent = title;
    $('model-pill-meta').textContent = meta;

    // Composer toggles
    document.querySelectorAll('[data-kind]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.kind === sel.kind);
    });
    const ctxBtn = $('context-toggle-btn');
    ctxBtn.classList.toggle('active', sel.includeContext);
    ctxBtn.setAttribute('aria-pressed', String(sel.includeContext));
    $('context-toggle-label').textContent = sel.includeContext ? 'Bağlam: Kısa özet' : 'Bağlam: Kapalı';
  }

  function findModelObj(routeId, modelId) {
    if (!modelId) return null;
    for (const p of state.pools) {
      const m = (p.models || []).find(x => x.modelId === modelId && (!routeId || x.routeId === routeId));
      if (m) return m;
    }
    return state.models.find(x => x.modelId === modelId && (!routeId || x.routeId === routeId)) || null;
  }

  function renderWorkspaceBar() {
    const ws = state.activeChat?.workspace || '';
    $('current-folder-label').textContent = ws ? folderName(ws) : 'Çalışma klasörü seç…';
    $('folder-picker-btn').title = ws || 'Çalışma klasörü seç';

    const chips = $('folder-chips');
    chips.replaceChildren();
    const combined = [...new Set([...state.favoriteFolders, ...state.recentFolders])].slice(0, 8);
    for (const dir of combined) {
      const isFav = state.favoriteFolders.includes(dir);
      chips.appendChild(el('button', {
        type: 'button',
        className: `folder-chip${dir === ws ? ' active' : ''}`,
        title: dir,
        text: `${isFav ? '★ ' : ''}${folderName(dir)}`,
        onClick: () => void selectWorkspace(dir),
      }));
    }
  }

  function renderChatList() {
    const list = $('chat-list');
    list.replaceChildren();
    if (!state.chats.length) {
      list.appendChild(el('div', { className: 'muted', text: 'Henüz sohbet yok.' }));
      return;
    }
    for (const chat of state.chats) {
      const row = el('div', { className: `chat-item${chat.id === state.activeChatId ? ' active' : ''}`, role: 'listitem' }, [
        el('button', {
          type: 'button',
          className: 'chat-item-main',
          onClick: () => {
            switchView('chat');
            void openChat(chat.id);
          },
        }, [
          el('div', { className: 'chat-item-title', text: chat.title || 'Yeni sohbet' }),
          el('div', { className: 'chat-item-meta', text: chat.workspace ? folderName(chat.workspace) : `${chat.messageCount || 0} mesaj` }),
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
      ]);
      list.appendChild(row);
    }
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
      msg.effort ? `(${msg.effort})` : '',
    ].filter(Boolean).join(' ');

    const bodyNodes = [
      el('div', { className: 'msg-head' }, [
        el('div', { className: 'msg-model-tag' }, [
          el('span', { text: modelText }),
          msg.kind ? el('span', { className: 'badge', text: KIND_LABELS[msg.kind] || msg.kind }) : null,
        ]),
        headRight,
      ]),
    ];

    if (msg.error) {
      bodyNodes.push(el('div', { className: 'error-box', text: msg.errorDetail || msg.error }));
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
      const details = el('details', { className: 'events-details', ...(isActive ? { open: true } : {}) }, [
        el('summary', { text: `Adımlar & olaylar (${msg.events.length})` }),
        el('ul', { className: 'events-list' }, msg.events.slice(-12).map(ev => {
          const line = typeof ev === 'string' ? ev : `${ev.type || 'olay'}${ev.message ? `: ${ev.message}` : ev.summary ? `: ${ev.summary}` : ''}`;
          return el('li', { text: line });
        })),
      ]);
      bodyNodes.push(details);
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
            msg.kind ? KIND_LABELS[msg.kind] : '',
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
      const card = el('div', { className: 'panel-card' }, [
        el('div', { className: 'card-row' }, [
          el('div', {}, [
            el('h3', { text: task.reportedModel || task.modelId || task.routeId || 'Görev' }),
            el('p', { className: 'muted', text: `${task.workspace ? folderName(task.workspace) : ''} · ${KIND_LABELS[task.kind] || task.kind || ''}${task.clientLabel ? ` · ${task.clientLabel}` : ''}` }),
          ]),
          el('span', { className: `badge ${cls}` }, [active ? el('span', { className: 'pulse-dot' }) : null, label]),
        ]),
        task.result ? el('p', { className: 'muted', text: String(task.result).slice(0, 180) }) : null,
        task.error ? el('div', { className: 'error-box', text: task.errorDetail || task.error }) : null,
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
      ]);
      container.appendChild(card);
    }
  }

  function renderPoolsView() {
    const qStrip = $('quotas-summary');
    qStrip.replaceChildren();
    for (const q of state.quotas || []) {
      const pct = Number.isFinite(q.remainingPercent) ? Math.round(q.remainingPercent) : null;
      const fillCls = pct == null ? '' : pct <= 10 ? ' danger' : pct <= 30 ? ' warn' : '';
      qStrip.appendChild(el('div', { className: 'quota-card' }, [
        el('div', { className: 'card-row' }, [
          el('strong', { text: q.routeId || q.adapter || 'Bağlantı' }),
          pct != null ? el('span', { className: 'badge', text: `%${pct}` }) : el('span', { className: 'badge', text: q.status || '?' }),
        ]),
        el('div', { className: 'muted', text: `${q.adapter || ''} · ${q.billing || ''} · ${q.models || 0} model` }),
        pct != null ? el('div', { className: 'quota-bar' }, el('div', { className: `quota-fill${fillCls}`, style: `width:${Math.max(0, Math.min(100, pct))}%` })) : null,
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
        className: `picker-item${state.selection.modelId === m.modelId && state.selection.routeId === m.routeId ? ' selected' : ''}`,
        onClick: () => {
          chooseModel({ ...m, group: pool.id });
          switchView('chat');
          toast(`${m.name || m.modelId} seçildi.`);
        },
      }, [
        el('div', { className: 'picker-item-main' }, [
          el('div', { className: 'picker-item-title', text: m.name || m.modelId }),
          el('div', { className: 'picker-item-sub', text: [m.routeId, m.effort ? `efor: ${m.effort}` : '', m.billing].filter(Boolean).join(' · ') }),
        ]),
        quotaBadge(m.quota),
      ]));

      grid.appendChild(el('div', { className: 'panel-card' }, [
        el('div', { className: 'card-row' }, [
          el('div', {}, [
            el('h3', { text: pool.label || pool.id }),
            el('p', { className: 'muted', text: `${models.length} model` }),
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
        el('div', { className: 'picker-list', style: 'margin-top:10px' }, items.length ? items : [el('p', { className: 'muted', text: 'Bu havuzda aktif model yok.' })]),
      ]));
    }
  }

  function renderSettingsView() {
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
      : 'Bu makinede aktif bir Tailscale IP (100.64.0.0/10) algılanmadı. Telefondan bağlanmak için bilgisayara ve telefona Tailscale kurup "cli-agent-pool remote --host tailscale" ile başlatın.';

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

  // --- Model / Pool / Effort Picker Dialog ---
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
    state.selection.group = model.group || model.category || (Array.isArray(model.categories) ? model.categories[0] || '' : '');
    state.selection.routeId = model.routeId || '';
    state.selection.modelId = model.modelId || '';
    state.selection.modelName = model.name || model.modelId || '';
    state.selection.efforts = Array.isArray(model.efforts) ? model.efforts : [];
    state.selection.effort = model.effort || (state.selection.efforts.includes(state.selection.effort) ? state.selection.effort : (state.selection.efforts[0] || ''));
    saveSelection();
    renderTopbarAndStatus();
  }

  function renderModelPicker() {
    const tabs = $('picker-pool-tabs');
    tabs.replaceChildren();
    const tabDefs = [
      { id: 'all', label: 'Tüm Katalog' },
      ...state.pools.map(p => ({ id: p.id, label: `${p.label || p.id} (${(p.models || []).length})` })),
    ];
    for (const t of tabDefs) {
      tabs.appendChild(el('button', {
        type: 'button',
        className: `chip-btn${state.pickerTab === t.id ? ' active' : ''}`,
        text: t.label,
        onClick: () => {
          state.pickerTab = t.id;
          renderModelPicker();
        },
      }));
    }

    // Effort chips if selected model has efforts
    const currentModel = findModelObj(state.selection.routeId, state.selection.modelId);
    const efforts = currentModel?.efforts || state.selection.efforts || [];
    const effBox = $('picker-effort-section');
    effBox.hidden = !efforts.length;
    if (efforts.length) {
      const effRow = $('picker-effort-chips');
      effRow.replaceChildren();
      for (const eff of efforts) {
        effRow.appendChild(el('button', {
          type: 'button',
          className: `chip-btn${state.selection.effort === eff ? ' active' : ''}`,
          text: eff,
          onClick: () => {
            state.selection.effort = eff;
            saveSelection();
            renderTopbarAndStatus();
            renderModelPicker();
          },
        }));
      }
    }

    const list = $('picker-models-list');
    list.replaceChildren();

    // Auto-select option for current tab
    const activePool = state.pools.find(p => p.id === state.pickerTab);
    list.appendChild(el('button', {
      type: 'button',
      className: `picker-item${!state.selection.modelId && state.selection.group === (activePool ? activePool.id : '') ? ' selected' : ''}`,
      onClick: () => {
        choosePoolAuto(activePool ? activePool.id : '');
        $('model-dialog').close();
      },
    }, [
      el('div', { className: 'picker-item-main' }, [
        el('div', { className: 'picker-item-title', text: activePool ? `✨ ${activePool.label || activePool.id} — Otomatik seç` : '✨ Otomatik en uygun model' }),
        el('div', { className: 'picker-item-sub', text: 'Kotası müsait en iyi modeli CLI Agent Pool kendisi seçer.' }),
      ]),
    ]));

    let sourceModels = activePool ? (activePool.models || []) : state.models;
    const q = state.pickerQuery.trim().toLowerCase();
    if (q) {
      sourceModels = sourceModels.filter(m =>
        [m.name, m.modelId, m.routeId, m.billing, m.account].some(s => String(s || '').toLowerCase().includes(q)),
      );
    }

    for (const m of sourceModels) {
      const selected = state.selection.modelId === m.modelId && state.selection.routeId === m.routeId;
      list.appendChild(el('button', {
        type: 'button',
        className: `picker-item${selected ? ' selected' : ''}`,
        onClick: () => {
          chooseModel({ ...m, group: activePool ? activePool.id : (m.category || m.categories?.[0] || '') });
          renderModelPicker();
          if (!m.efforts?.length) $('model-dialog').close();
        },
      }, [
        el('div', { className: 'picker-item-main' }, [
          el('div', { className: 'picker-item-title', text: m.name || m.modelId }),
          el('div', { className: 'picker-item-sub', text: [m.routeId, m.efforts?.length ? `efor: ${m.efforts.join('/')}` : '', m.billing].filter(Boolean).join(' · ') }),
        ]),
        quotaBadge(m.quota),
      ]));
    }
  }

  // --- Folder Browser Dialog ---
  async function loadFolderBrowser(targetPath = '') {
    try {
      const data = await api(`/r/dirs?path=${encodeURIComponent(targetPath)}`);
      state.folderBrowser = data;
      renderFolderBrowser();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function renderFolderBrowser() {
    const fb = state.folderBrowser;
    $('folder-browser-path').textContent = fb.current || 'Kök klasörler';
    $('folder-up-btn').disabled = !fb.parent && !fb.current;
    $('folder-select-current-btn').disabled = !fb.current;
    const isFav = fb.current && state.favoriteFolders.includes(fb.current);
    $('folder-star-btn').textContent = isFav ? '★' : '☆';
    $('folder-star-btn').disabled = !fb.current;

    const favSec = $('folder-favorites-section');
    favSec.hidden = !state.favoriteFolders.length;
    const favList = $('folder-favorites-list');
    favList.replaceChildren();
    for (const dir of state.favoriteFolders) {
      favList.appendChild(el('button', {
        type: 'button',
        className: 'picker-item',
        onClick: () => void selectWorkspace(dir, true),
      }, [
        el('div', { className: 'picker-item-main' }, [
          el('div', { className: 'picker-item-title', text: `★ ${folderName(dir)}` }),
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
          text: 'Seç',
          onClick: () => void selectWorkspace(entry.path, true),
        }),
      ]));
    }
  }

  async function selectWorkspace(dir, closeDialog = false) {
    if (!dir) return;
    if (!state.activeChatId) await createNewChat(dir);
    else {
      try {
        const res = await api(`/r/chats/${encodeURIComponent(state.activeChatId)}`, {
          method: 'PATCH',
          body: { workspace: dir },
        });
        state.activeChat = res.chat;
      } catch (err) {
        toast(err.message, true);
        return;
      }
    }
    if (!state.recentFolders.includes(dir)) state.recentFolders = [dir, ...state.recentFolders].slice(0, 12);
    renderWorkspaceBar();
    if (closeDialog) $('folder-dialog').close();
    toast(`Klasör: ${folderName(dir)}`);
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
      body.replaceChildren(
        el('div', { className: 'card-row' }, [
          el('strong', { text: task.reportedModel || task.modelId || task.routeId || 'Görev' }),
          el('span', { className: `badge ${cls}`, text: label }),
        ]),
        el('div', { className: 'muted mono', text: `ID: ${task.id}` }),
        task.workspace ? el('div', { className: 'muted mono', text: `Klasör: ${task.workspace}` }) : null,
        task.error ? el('div', { className: 'error-box', text: task.errorDetail || task.error }) : null,
        task.result ? el('div', {}, [el('div', { className: 'sub-label', text: 'Yanıt' }), renderMarkdown(task.result)]) : null,
        task.events?.length ? el('div', {}, [
          el('div', { className: 'sub-label', text: `Olaylar (${task.events.length})` }),
          el('pre', { className: 'code-block', text: task.events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') }),
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
      renderWorkspaceBar();
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

  async function createNewChat(preferredWorkspace = '') {
    const ws = preferredWorkspace || state.activeChat?.workspace || state.favoriteFolders[0] || state.recentFolders[0] || '';
    try {
      const { chat } = await api('/r/chats', { method: 'POST', body: { workspace: ws } });
      state.chats = [{ id: chat.id, title: chat.title, workspace: chat.workspace, updatedAt: chat.updatedAt, messageCount: 0 }, ...state.chats];
      state.activeChatId = chat.id;
      state.activeChat = chat;
      renderChatList();
      renderWorkspaceBar();
      renderMessages(false);
      setDrawer(false);
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
    if (!state.activeChatId) await createNewChat();
    const workspace = state.activeChat?.workspace || state.favoriteFolders[0] || state.recentFolders[0] || '';
    if (!workspace) {
      toast('Önce bir çalışma klasörü seçin.', true);
      $('folder-dialog').showModal();
      void loadFolderBrowser('');
      return;
    }

    state.sending = true;
    $('send-btn').disabled = true;
    try {
      const res = await api(`/r/chats/${encodeURIComponent(state.activeChatId)}/send`, {
        method: 'POST',
        body: {
          prompt: text,
          workspace,
          kind: state.selection.kind,
          mode: state.selection.kind === 'write' ? 'execute' : 'response',
          includeContext: state.selection.includeContext,
          ...(state.selection.group ? { group: state.selection.group } : {}),
          ...(state.selection.routeId ? { routeId: state.selection.routeId } : {}),
          ...(state.selection.modelId ? { modelId: state.selection.modelId } : {}),
          ...(state.selection.effort ? { effort: state.selection.effort } : {}),
        },
      });
      input.value = '';
      state.activeChat = res.chat;
      renderMessages(true);
      if (res.task?.id) watchTask(res.chat.id, res.task.id);
      void refreshState(false);
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.sending = false;
      $('send-btn').disabled = false;
    }
  }

  // --- Voice Dictation (Web Speech API) ---
  function toggleVoiceDictation() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      toast('Bu tarayıcı sesli yazmayı desteklemiyor. Mobil klavye mikrofonunu kullanabilirsiniz.', true);
      return;
    }
    if (state.recording && state.recognition) {
      state.recognition.stop();
      return;
    }
    const rec = new SpeechRec();
    rec.lang = 'tr-TR';
    rec.continuous = true;
    rec.interimResults = true;
    const input = $('prompt-input');
    const baseText = input.value ? `${input.value.trimEnd()} ` : '';

    rec.onstart = () => {
      state.recording = true;
      state.recognition = rec;
      $('mic-btn').classList.add('recording');
      $('mic-status').hidden = false;
    };
    rec.onresult = e => {
      let transcript = '';
      for (let i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      input.value = `${baseText}${transcript}`;
    };
    rec.onerror = e => {
      toast(e.error === 'not-allowed' ? 'Mikrofon izni reddedildi (telefonda HTTPS veya klavye mikrofonu gerekebilir).' : `Ses hatası: ${e.error}`, true);
    };
    rec.onend = () => {
      state.recording = false;
      state.recognition = null;
      $('mic-btn').classList.remove('recording');
      $('mic-status').hidden = true;
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
      state.favoriteFolders = data.favoriteFolders || [];
      state.recentFolders = data.recentFolders || [];
      state.workspaceRoots = data.workspaceRoots || [];
      state.devices = data.devices || [];
      state.tailscaleIp = data.tailscaleIp || null;
      state.port = data.port || 43128;
      state.hostMode = data.hostMode || '127.0.0.1';

      renderTopbarAndStatus();
      renderChatList();
      renderWorkspaceBar();
      if (state.view === 'calls') renderCallsView();
      if (state.view === 'pools') renderPoolsView();
      if (state.view === 'settings') renderSettingsView();

      if (openInitialChat) {
        if (state.chats.length) await openChat(state.chats[0].id);
        else await createNewChat();
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // --- Wire Events ---
  function bindEvents() {
    $('open-drawer-btn').addEventListener('click', () => setDrawer(true));
    $('close-drawer-btn').addEventListener('click', () => setDrawer(false));
    $('drawer-backdrop').addEventListener('click', () => setDrawer(false));

    document.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    $('new-chat-btn').addEventListener('click', () => void createNewChat());
    $('quick-new-chat-btn').addEventListener('click', () => {
      switchView('chat');
      void createNewChat();
    });
    $('quick-pool-btn').addEventListener('click', () => switchView('settings'));

    $('model-pill-btn').addEventListener('click', () => {
      renderModelPicker();
      $('model-dialog').showModal();
    });
    $('model-search-input').addEventListener('input', e => {
      state.pickerQuery = e.target.value;
      renderModelPicker();
    });

    $('folder-picker-btn').addEventListener('click', () => {
      $('folder-dialog').showModal();
      void loadFolderBrowser(state.activeChat?.workspace || '');
    });
    $('folder-up-btn').addEventListener('click', () => void loadFolderBrowser(state.folderBrowser.parent || ''));
    $('folder-select-current-btn').addEventListener('click', () => void selectWorkspace(state.folderBrowser.current, true));
    $('folder-star-btn').addEventListener('click', async () => {
      if (!state.folderBrowser.current) return;
      try {
        const res = await api('/r/folders/favorite', { method: 'POST', body: { path: state.folderBrowser.current } });
        state.favoriteFolders = res.favoriteFolders || [];
        renderFolderBrowser();
        renderWorkspaceBar();
      } catch (err) { toast(err.message, true); }
    });

    document.querySelectorAll('[data-kind]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.selection.kind = btn.dataset.kind;
        saveSelection();
        renderTopbarAndStatus();
      });
    });

    $('context-toggle-btn').addEventListener('click', () => {
      state.selection.includeContext = !state.selection.includeContext;
      saveSelection();
      renderTopbarAndStatus();
    });

    document.querySelectorAll('.quick-prompt-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        $('prompt-input').value = btn.dataset.prompt || '';
        $('prompt-input').focus();
      });
    });

    // IME-safe Enter submit (ime-safe-enter-submit)
    const composerForm = $('composer-form');
    composerForm.addEventListener('submit', sendPrompt);
    $('prompt-input').addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      composerForm.requestSubmit();
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

    $('open-pair-sidebar-btn').addEventListener('click', () => { setDrawer(false); void openPairingDialog(); });
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
  void refreshState(true);
  setInterval(() => {
    if (!document.hidden) void refreshState(false);
  }, 15_000);
})();
