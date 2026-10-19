import { memberships, mergeScanDraft, addMembership, quotaWindows, effortLabel, modelIdentity, modelFamily, modelFiltered, sortModels, initialTaskGroup, restoredWorkspace } from '/pool-state.js';
const $ = id => document.getElementById(id);
const labels = { queued: 'Sırada', starting: 'Başlatılıyor', running: 'Çalışıyor', succeeded: 'Tamamlandı', failed: 'Başarısız', timed_out: 'Süre doldu', cancelling: 'Durduruluyor', cancelled: 'Durduruldu', needs_review: 'Elle inceleme gerekli' };
const billingLabels = { subscription: 'Abonelik', token_plan: 'Token planı', free_credits: 'Günlük / ücretsiz kredi', free: 'Ücretsiz', paid_api: 'Ücretli API', unknown: 'Doğrulanmadı' };
const activeBillings = new Set(['subscription', 'token_plan', 'free_credits', 'free', 'paid_api']);
let snapshot = null;
let settings = null;
let baseConfig = null;
let busy = false;
let refreshing = false;
let submitted = null;
let modelSignature = '';
let selectedTask = null;
let selectedTaskStamp = '';
let conversationRoot = null;
let skills = [];
let poolDirty = false;
let selectedRoute = '';
let selectedGroup = 'high';
let quotasOpen = true;
const quotaStates = new Map();
let noticeTimer;
let taskGroupInitialized = false;
let selectedFamily = '';
let viewPreferences = {};
try { viewPreferences = JSON.parse(localStorage.getItem('pool-view') || '{}'); if (!viewPreferences || typeof viewPreferences !== 'object' || Array.isArray(viewPreferences)) viewPreferences = {}; } catch { /* Browser defaults remain usable. */ }
selectedRoute = typeof viewPreferences.selectedRoute === 'string' ? viewPreferences.selectedRoute : '';
selectedFamily = typeof viewPreferences.selectedFamily === 'string' ? viewPreferences.selectedFamily : '';
if (['high','medium','low'].includes(viewPreferences.selectedGroup)) selectedGroup = viewPreferences.selectedGroup;
if (typeof viewPreferences.quotasOpen === 'boolean') quotasOpen = viewPreferences.quotasOpen;
for (const [key,value] of Object.entries(viewPreferences.quotaStates || {})) if (typeof value === 'boolean') quotaStates.set(key,value);
function rememberView() {
  try { localStorage.setItem('pool-view', JSON.stringify({ ...viewPreferences, selectedRoute, selectedFamily, selectedGroup, quotasOpen, quotaStates: Object.fromEntries(quotaStates) })); } catch { /* Current-page choices still work. */ }
}
for (const id of ['catalog-view','catalog-sort','member-view']) {
  if ([...$(id).options].some(option => option.value === viewPreferences[id])) $(id).value = viewPreferences[id];
  $(id).addEventListener('change', () => { viewPreferences[id] = $(id).value; rememberView(); $('pool-models').scrollTop = 0; renderPool(); });
}
function setPanel(name, open) {
  $(`${name}-content`).hidden = !open; $(`toggle-${name}`).setAttribute('aria-expanded', String(open));
  $(`${name}-area`).classList.toggle('collapsed', !open);
  $('pool-panel').classList.toggle('catalog-closed', name === 'catalog' ? !open : $('catalog-content').hidden);
}
for (const name of ['pool','catalog']) {
  setPanel(name, viewPreferences[name] !== false);
  $(`toggle-${name}`).addEventListener('click', () => { const open = $(`${name}-content`).hidden; setPanel(name,open); viewPreferences[name] = open; rememberView(); });
}
let quotasRefreshing = false;
let quotaErrors = {};
let pendingPoolModel = null;
const adapterLabels = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', zcode: 'ZCode', qwen: 'Qwen', mcode: 'MiniMax Code', mmx: 'MiniMax CLI', kimi: 'Kimi', mimo: 'MiMo', agy: 'Antigravity', omniroute: 'OmniRoute', lmstudio: 'LM Studio', ollama: 'Ollama', hermes: 'Hermes', aider: 'Aider', kilocode: 'Kilo', custom: 'Özel araç' };
const strengthGroups = ['high', 'medium', 'low'];

const groupLabels = { high: 'Yüksek', medium: 'Orta', low: 'Hafif', unassigned: 'Sınıflandırılmamış' };
const groupLabel = group => Object.hasOwn(groupLabels, group) ? groupLabels[group] : groupLabels.unassigned;
try { $('theme').value = localStorage.getItem('pool-theme-v2') || 'dark'; } catch { /* Storage may be disabled. */ }
function applyTheme() {
  const theme = ['light', 'dark', 'system'].includes($('theme').value) ? $('theme').value : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
}
applyTheme();
$('theme').addEventListener('change', () => { applyTheme(); try { localStorage.setItem('pool-theme-v2', $('theme').value); } catch { /* Current-page theme still works. */ } });
function updateSave() {
  $('save-pool').hidden = !poolDirty;
  $('save-pool').disabled = busy || !poolDirty; $('save-pool').dataset.locked = String(!poolDirty);
  $('discard-settings').hidden = !poolDirty;
}
function dirty() { poolDirty = true; updateSave(); }



function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(message, error = false) { clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000); }
async function call(operation, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), operation === 'pick_folder' ? 185_000 : ['scan_import', 'quotas'].includes(operation) ? 90_000 : 30_000);
  try {
    const response = await fetch('/ui', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, payload }), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || 'İşlem tamamlanamadı. Yeniden deneyin.');
    if (operation === 'save') { poolDirty = false; updateSave(); baseConfig = structuredClone(value.config); }
    if (operation === 'settings' && !poolDirty) baseConfig = structuredClone(value.config);
    return value;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') throw new Error('Havuza ulaşılamıyor. Servisi kontrol edip yeniden deneyin; görev tanımınız korunuyor.');
    throw error;
  } finally { clearTimeout(timer); }
}
async function action(operation) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = true; });
  try { await operation(); }
  catch (error) { notice(error.message, true); }
  finally {
    busy = false;
    document.querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = node.dataset.locked === 'true'; });
    updateSubmit();
    updateSave();
  }
}
function availableModels() { return (snapshot?.models || []).filter(model => !modelFiltered(settings?.config.modelFilters, model.routeId, model.id) && model.enabled && activeBillings.has(model.billing) && model.kinds.includes($('task-kind').value) && (!$('task-group').value || model.group === $('task-group').value)); }
function updateSubmit() {
  const reason = !$('task-workspace').value ? 'Başlamak için proje klasörünü seçin.' : !availableModels().length ? poolDirty ? 'Havuz değişikliklerini üstteki ✓ düğmesiyle kaydedin.' : 'Bu görev için seçilen havuzda etkin model yok. Başka havuz seçin veya Modeller ekranından ekleyin.' : availableModels().every(model => snapshot?.quotas?.[model.routeId]?.status === 'auth_required') ? 'Giriş gerekli. Modeller ekranında bağlantınızın Giriş yap düğmesini kullanın.' : $('voice-input').getAttribute('aria-pressed') === 'true' ? 'Sesle yazmayı tamamlayın.' : '';
  $('submit').disabled = busy || Boolean(reason) || !$('task-prompt').value.trim();
  $('model-empty').textContent = reason; $('model-empty').hidden = !reason;
  $('submit').title = reason || 'Görevi gönder';
}
$('task-prompt').addEventListener('input', updateSubmit);
$('task-prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('submit').disabled) $('task-form').requestSubmit(); } });
function updateModels() {
  const previous = $('task-model').value;
  const models = availableModels();
  const signature = JSON.stringify(models);
  if (signature !== modelSignature) {
    modelSignature = signature;
    $('task-model').replaceChildren(new Option('Havuzdaki uygun model', ''), ...models.map(model => new Option(`${model.id} · ${adapterLabels[model.adapter] || model.adapter} · ${groupLabel(model.group)}`, JSON.stringify([model.routeId, model.id, model.group]))));
    if (models.some(model => JSON.stringify([model.routeId, model.id, model.group]) === previous)) $('task-model').value = previous;
  }
  updateEfforts();
  updateSubmit();

  $('write-warning').hidden = $('task-kind').value !== 'write';
}
function updateEfforts() {
  const models = availableModels();
  const selected = models.find(model => JSON.stringify([model.routeId, model.id, model.group]) === $('task-model').value);
  const locked = snapshot?.selectionMode === 'manual' || Boolean(selected?.fixedEffort);
  const efforts = locked ? [] : [...new Set((selected ? [selected] : models).flatMap(model => model.efforts))];
  const previous = $('task-effort').value;
  $('task-effort').replaceChildren(new Option(selected?.fixedEffort ? `${effortLabel(selected.fixedEffort)} · havuz kuralı` : 'Havuzdaki efor kurallarını uygula', selected?.fixedEffort || ''), ...efforts.map(effort => new Option(effortLabel(effort), effort)));
  if (!locked && efforts.includes(previous)) $('task-effort').value = previous;
  $('task-effort').closest('label').hidden = snapshot?.selectionMode === 'manual';
  $('task-effort').disabled = locked || busy; $('task-effort').dataset.locked = String(locked);
}
function showDetail(value) {
  $('detail-heading').textContent = value.windows ? 'Kota bilgisi' : 'Görev bilgisi';
  $('detail-content').replaceChildren(...(value.windows ? [quotaBody(value)] : [element('p', labels[value.state] || 'Görev'), element('p', value.modelId || ''), element('pre', value.result || value.error || '')]));
  $('detail').hidden = false; if (!$('detail').open) $('detail').showModal(); $('detail-heading').tabIndex = -1; $('detail-heading').focus();
}
function button(text, operation) { const node = element('button', text); node.type = 'button'; node.disabled = busy; node.addEventListener('click', () => void action(operation)); return node; }
function formatQuotaSummary(conn, q) {
  if (!q) return conn.protocol ? `${conn.protocol.toUpperCase()} API · ${conn.baseUrl}` : `Giriş komutu: ${conn.loginCommand || conn.adapter}`;
  if (q.status === 'unknown' && !q.windows?.length) return 'Kota bilgisi bu bağlantıda bilinmiyor';
  if (q.status === 'auth_required') return `Giriş gerekli: terminalde "${q.loginCommand || conn.loginCommand}" çalıştırın`;
  if (q.windows?.length) return q.windows.map(w => `${w.bucketId ? `${w.bucketId} / ` : ''}${w.name}: ${Number.isFinite(w.remainingPercent) ? `%${w.remainingPercent} kalan` : 'kalan bilinmiyor'}${w.resetsAt ? ` · Yenilenme: ${new Date(typeof w.resetsAt === 'number' && w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt).toLocaleString('tr-TR')}` : ''}`).join(' · ');
  if (q.subscription === 'active') return 'Etkin token planı doğrulandı';
  if (q.subscription === 'none' && conn.billing === 'free_credits') return 'Token planı yok · Günlük / ücretsiz kredi modu etkin';
  if (q.subscription === 'none') return 'Etkin token planı yok (günlük kredi için free_credits seçin)';
  if (q.endpoint) return `Uç nokta: ${q.endpoint}`;
  return `Durum: ${q.status}${q.auth ? ` (${q.auth})` : ''}`;
}
async function runScanImport(routeId) {
  const draft = poolDirty ? structuredClone(settings.config) : null;
  const before = baseConfig || settings?.config;
  const res = await call('scan_import', typeof routeId === 'string' ? { routeId } : {});
  settings = { ...res, config: draft ? mergeScanDraft(res.config, before, draft) : res.config };
  poolDirty = Boolean(draft);
  baseConfig = structuredClone(res.config);
  renderPool(); if (!$('settings').hidden) renderSettings(); await refresh();
  notice(`Tarama: ${res.discoveredCount} araç, ${res.addedModels} yeni model. ${draft ? 'Kaydetmediğiniz seçimler korundu.' : 'Katalog güncellendi.'}${res.catalogErrors?.length ? ` ${res.catalogErrors.map(error => `${error.routeId}: ${error.message}`).join(' ')}` : ''}`, Boolean(res.catalogErrors?.length));
  void refreshQuotas();
}
async function refresh(announce = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const wasOffline = $('connection-state').textContent === 'Bağlantı yok';
    snapshot = await call('snapshot');
    $('app-version').textContent = `v${snapshot.version || 'bilinmiyor'}`;
    if (!settings || (!poolDirty && settings.revision !== snapshot.revision)) { settings = await call('settings'); renderPool(); if (!$('settings').hidden) renderSettings(); }
    if (!$('task-workspace').value) { try { $('task-workspace').value = restoredWorkspace(localStorage.getItem('pool-project'), snapshot.workspaceRoots); } catch { /* Keep explicit project selection available. */ } }
    renderProjects();
    const previousGroup = $('task-group').value;
    $('task-group').replaceChildren(...(snapshot.selectionMode === 'auto' ? [new Option('Ajan otomatik seçsin', '')] : []), ...strengthGroups.map(group => new Option(groupLabel(group), group)));
    $('task-group').value = initialTaskGroup(snapshot.models.filter(model => activeBillings.has(model.billing) && model.kinds.includes($('task-kind').value)), snapshot.selectionMode, previousGroup, taskGroupInitialized); taskGroupInitialized = true;
    $('connection-state').textContent = 'Bağlı'; $('connection-state').dataset.connected = 'true'; $('connection-state').title = 'Bağlı';
    $('installed-count').textContent = snapshot.installed.filter(cli => cli.status === 'installed').length;
    $('model-count').textContent = new Set(snapshot.models.filter(model => model.enabled && (snapshot.selectionMode === 'auto' || strengthGroups.includes(model.group))).map(model => `${model.routeId}/${model.id}`)).size;
    $('running-count').textContent = snapshot.tasks.filter(task => ['starting', 'running', 'cancelling'].includes(task.state)).length;
    $('review-count').textContent = snapshot.tasks.filter(task => task.state === 'needs_review').length;
    const projectTasks = snapshot.tasks.filter(task => task.workspace === $('task-workspace').value);
    $('task-total').textContent = projectTasks.length;
    const currentRoot = $('task-workspace').value;
    if (currentRoot && conversationRoot !== currentRoot) {
      conversationRoot = currentRoot; $('conversation').replaceChildren();
      for (const previous of [...projectTasks].reverse()) { if ($('task-workspace').value !== currentRoot) break; await openTask(previous.id, false); }
    }
    const providerRows = [];
    for (const conn of snapshot.connections) {
      const row = element('div', null, 'provider');
      const info = element('div');
      const titleLine = element('div', null, 'task-title');
      titleLine.append(element('strong', `${conn.id} (${conn.protocol ? `${conn.protocol} API` : conn.adapter})`), element('span', billingLabels[conn.billing] || conn.billing, 'badge subtle'));
      info.append(titleLine, element('small', formatQuotaSummary(conn, snapshot.quotas?.[conn.id])));
      const right = element('div', null, 'actions');
      right.append(element('span', conn.enabled ? 'Etkin' : 'Kapalı', 'provider-state'));
      row.append(info, right);
      providerRows.push(row);
    }
    for (const cli of snapshot.installed) {
      if (snapshot.connections.some(c => c.adapter === cli.adapter && !c.protocol)) continue;
      const row = element('div', null, 'provider');
      const info = element('div');
      info.append(element('strong', `${cli.label || cli.adapter} (${cli.adapter})`));
      const modelCount = cli.discoveredModels?.length || 0;
      info.append(element('small', cli.status === 'installed' ? `Kurulu · ${modelCount} model bulundu · Giriş: ${cli.loginCommand}` : 'Bilgisayarda bulunamadı'));
      row.append(info, element('span', cli.status === 'installed' ? 'Kurulu' : 'Bulunamadı', 'provider-state'));
      providerRows.push(row);
    }
    $('providers').replaceChildren(...providerRows);
    const focusedId = document.activeElement?.id;
    $('tasks').replaceChildren(...(projectTasks.length ? projectTasks.map(task => {
      const row = element('div', null, 'task');
      const title = element('div', null, 'task-title'); title.append(element('strong', `Seçilen: ${task.modelId} · ${task.routeId}`), element('span', labels[task.state] || task.state, 'badge subtle'));
      const actions = element('div', null, 'actions');
      const resultButton = button('Sonucu görüntüle', async () => { await openTask(task.id); }); resultButton.id = `result-${task.id}`; actions.append(resultButton);
      if (['queued', 'starting', 'running'].includes(task.state)) { const cancelButton = button('Durdur', async () => { showDetail(await call('cancel', { taskId: task.id })); await refresh(); }); cancelButton.id = `cancel-${task.id}`; actions.append(cancelButton); }
      row.append(title, element('small', `${task.workspace || ''} · ${new Date(task.created).toLocaleString('tr-TR')}`), actions); return row;
    }) : [element('p', 'Henüz görev yok. İlk görevinizi formdan başlatın.', 'empty')]));
    if (focusedId?.startsWith('result-') || focusedId?.startsWith('cancel-')) $(focusedId)?.focus({ preventScroll: true });
    updateModels();
    if (selectedTask) await openTask(selectedTask, false);
    if (wasOffline) notice('Bağlantı yeniden kuruldu.');
  } catch (error) { $('connection-state').textContent = 'Bağlantı yok'; $('connection-state').dataset.connected = 'false'; $('connection-state').title = 'Bağlantı yok'; notice(error.message, true); }
  finally { refreshing = false; }
}
function settingField(label, value, update, choices, markDirty = true) {
  const wrapper = element('label', null, 'setting-field'); wrapper.append(element('span', label));
  const input = choices ? document.createElement('select') : document.createElement('input');
  if (choices) input.replaceChildren(...choices.map(choice => new Option(Array.isArray(choice) ? choice[1] : effortLabel(choice), Array.isArray(choice) ? choice[0] : choice)));
  else input.maxLength = 100;
  input.value = value;
  input.addEventListener('change', () => { update(input.value); if (markDirty) dirty(); }); wrapper.append(input); return wrapper;
}
function renderSettings() {
  const expanded = new Set([...$('settings-routes').querySelectorAll('details[open]')].map(node => node.dataset.routeId));
  const previousAdapter = $('new-adapter').value;
  const adapters = snapshot.installed.filter(cli => cli.status === 'installed');
  $('new-adapter').replaceChildren(new Option('CLI seçin', ''), ...adapters.map(cli => new Option(`${cli.label || cli.adapter} (${cli.discoveredModels?.length || 0} model)`, cli.adapter)));
  if (adapters.some(cli => cli.adapter === previousAdapter)) $('new-adapter').value = previousAdapter;
  const billingChoices = Object.entries(billingLabels).map(([k, v]) => [k, v]);
  $('settings-routes').replaceChildren(...settings.config.routes.map(route => {
    const section = element('details', null, 'route-settings'); section.dataset.routeId = route.id; section.open = expanded.has(route.id);
    const summary = element('summary'); summary.append(element('strong', adapterLabels[route.adapter] || route.adapter), element('span', `${route.id} · ${route.enabled ? 'Etkin' : 'Kapalı'}`, 'hint')); section.append(summary);
    const body = element('div', null, 'settings-body');
    const header = element('label', null, 'route-header'); const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.checked = route.enabled; enabled.disabled = !activeBillings.has(route.billing);
    enabled.dataset.locked = String(!activeBillings.has(route.billing));
    enabled.addEventListener('change', () => { route.enabled = enabled.checked; });
    header.append(enabled, element('strong', `${route.id} · ${route.api ? `${route.api.protocol} API (${route.adapter})` : route.adapter}`));
    body.append(header);
    body.append(settingField('Ödeme / plan türü', route.billing, value => {
      route.billing = value;
      enabled.disabled = !activeBillings.has(value);
      enabled.dataset.locked = String(!activeBillings.has(value));
    }, billingChoices));
    if (route.billing === 'paid_api') {
      const autoLabel = element('label', null, 'route-header'); const autoCheck = document.createElement('input');
      autoCheck.type = 'checkbox'; autoCheck.checked = Boolean(route.autoSelect);
      autoCheck.addEventListener('change', () => { route.autoSelect = autoCheck.checked; });
      autoLabel.append(autoCheck, element('span', 'Ücretli API’nin otomatik model seçimine girmesine izin ver')); body.append(autoLabel);
    }
    if (route.api) {
      body.append(settingField('API adresi', route.api.baseUrl, value => { route.api.baseUrl = value; }));
      const secretRef = route.api.secretRef || route.id;
      route.api.secretRef = secretRef;
      const hasKey = settings.secretStates?.[route.id];
      const keyRow = element('div', null, 'actions');
      const keyInput = document.createElement('input'); keyInput.type = 'password'; keyInput.placeholder = hasKey ? 'Kayıtlı anahtar var (değiştirmek için yeni anahtar yazın)' : 'API anahtarı girin';
      const keyBtn = button('Anahtarı kaydet', async () => {
        if (!keyInput.value.trim()) throw new Error('Kaydedilecek API anahtarını girin.');
        await call('secret', { secretRef, secret: keyInput.value });
        keyInput.value = '';
        settings.secretStates ||= {}; settings.secretStates[route.id] = true; renderSettings(); await refresh();
        notice(`${route.id} için API anahtarı yerel kasaya kaydedildi.`);
      });
      keyRow.append(keyInput, keyBtn); body.append(keyRow);
    } else if (route.adapter !== 'codex') {
      const trustedLabel = element('label', null, 'route-header'); const trusted = document.createElement('input');
      trusted.type = 'checkbox'; trusted.checked = route.trustedSettings;
      trusted.addEventListener('change', () => { route.trustedSettings = trusted.checked; });
      trustedLabel.append(trusted, element('span', `CLI yerel ayarlarını inceledim (Giriş komutu: ${loginCommandsLabel(route.adapter)})`)); body.append(trustedLabel);
    }
    body.append(settingField('Öncelik (küçük değer önce)', route.priority, value => { route.priority = Number(value); }));
    body.append(settingField('Seçim için asgari kalan kota (%)', route.minRemainingPercent, value => { route.minRemainingPercent = Number(value); }));
    body.append(element('p', 'Modelleri üstteki havuz görünümünden sınıflandırabilirsiniz.', 'hint'));
    const addModelRow = element('div', null, 'actions');
    const newModelInput = document.createElement('input'); newModelInput.placeholder = 'Bu bağlantıya yeni model kimliği ekle';
    const addModelBtn = button('Model ekle', async () => {
      const id = newModelInput.value.trim();
      if (!id) throw new Error('Model kimliği girin.');
      if (route.models.some(m => m.id === id)) throw new Error('Bu model zaten ekli.');
      const kinds = route.adapter === 'mmx' ? ['text'] : route.adapter === 'qwen' ? ['text', 'read'] : ['text', 'read', 'write'];
      route.models.push({ id, alias: id, group: route.billing === 'free' ? 'free' : 'unassigned', enabled: true, efforts: [], kinds });
      newModelInput.value = ''; dirty(); renderSettings(); renderPool();
    });
    const manualModel = element('details'); manualModel.append(element('summary', 'Model kimliği ekle')); addModelRow.append(newModelInput, addModelBtn); manualModel.append(addModelRow); body.append(manualModel);
    const routeActions = element('div', null, 'actions');
    routeActions.append(button('Plan / kota durumunu sorgula', async () => { const q = await call('quota', { routeId: route.id }); await refresh(); showDetail(q); }));
    if (!route.api && route.adapter !== 'custom') {
      routeActions.append(button('Model sürümlerini yenile', async () => { await refreshCatalog(route.id); }));
    }
    if (!route.api && !['custom','lmstudio','ollama'].includes(route.adapter)) routeActions.append(button('Giriş yap', async () => { const result = await call('login', { routeId: route.id }); notice(result.message); }));
    body.append(routeActions, loginNotice(route));
    section.append(body);
    return section;
  }));
  if (!settings.config.routes.length) $('settings-routes').append(element('p', 'Henüz bağlantı yok. Üstteki "Bilgisayarı tara ve tümünü havuza aktar" düğmesine basın veya aşağıdan ekleyin.', 'empty'));
  if (busy) $('settings-routes').querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = true; });
}
function loginCommandsLabel(adapter) {
  const found = snapshot?.installed?.find(cli => cli.adapter === adapter);
  return found?.loginCommand || adapter;
}
$('new-adapter').addEventListener('change', () => {
  const adapter = $('new-adapter').value;
  const cli = snapshot?.installed?.find(item => item.adapter === adapter);
  if (cli?.defaultBilling) $('new-billing').value = cli.defaultBilling;
});
$('task-kind').addEventListener('change', updateModels);
$('refresh').addEventListener('click', () => void action(async () => { await refresh(); await refreshQuotas(); }));
$('scan-import').addEventListener('click', () => void action(runScanImport));
$('close-detail').addEventListener('click', () => { $('detail').close(); $('detail').hidden = true; ($('workspace-panel').hidden ? $('pool-tab') : $('task-prompt')).focus(); });
$('open-settings').addEventListener('click', () => switchPage('settings'));
async function saveSettings() {
  settings = await call('save', settings); poolDirty = false; renderSettings(); renderPool(); await refresh(); notice('Kaydedildi.');
}
$('save-pool').addEventListener('click', () => void action(saveSettings));
$('settings').addEventListener('change', event => { if (event.target.id !== 'theme') dirty(); });
$('add-route').addEventListener('click', () => void action(async () => {
  const adapter = $('new-adapter').value;
  const billing = $('new-billing').value;
  const cli = snapshot.installed.find(cli => cli.adapter === adapter && cli.executable);
  if (!cli) throw new Error('Kurulu bir CLI seçin.');
  if (!$('subscription-confirmed').checked) throw new Error('Önce CLI’ın seçtiğiniz ödeme/plan türüyle yapılandırıldığını onaylayın.');
  const modelId = $('new-model').value.trim();
  let id = `${adapter}-local`;
  let suffix = 2;
  while (settings.config.routes.some(route => route.id === id)) id = `${adapter}-local-${suffix++}`;
  const kinds = adapter === 'mmx' ? ['text'] : adapter === 'qwen' ? ['text', 'read'] : ['text', 'read', 'write'];
  const initialModels = modelId
    ? [{ id: modelId, alias: modelId, group: billing === 'free' ? 'free' : 'unassigned', enabled: true, efforts: [], kinds }]
    : (cli.discoveredModels || []).map(({ free, ...m }) => m);
  const route = { id, adapter, executable: cli.executable, enabled: false, billing, trustedSettings: true, priority: 100, maxConcurrent: 1, models: initialModels };
  settings.config.routes.push(route);
  settings = await call('save', settings);
  if (!modelId && ['codex', 'opencode', 'mimo'].includes(adapter)) {
    try {
      const catalog = await call('catalog', { routeId: id });
      settings.config.routes.find(connection => connection.id === id).models = catalog.models.map(model => ({ id: model.id, alias: model.name, group: model.free ? 'free' : 'unassigned', enabled: true, efforts: model.efforts, kinds }));
      settings = await call('save', settings);
    } catch {}
  }
  $('new-model').value = ''; $('subscription-confirmed').checked = false;
  renderSettings(); renderPool(); await refresh(); notice(`${id} bağlantısı (${initialModels.length} model) eklendi.`);
}));
$('add-api-route').addEventListener('click', () => void action(async () => {
  const id = $('api-id').value.trim();
  const protocol = $('api-protocol').value;
  const billing = $('api-billing').value;
  const baseUrl = $('api-base-url').value.trim();
  const apiKey = $('api-key').value.trim();
  const modelNames = $('api-models').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Bağlantı kimliği yalnızca harf, rakam, tire ve alt çizgi içermelidir.');
  if (settings.config.routes.some(route => route.id === id)) throw new Error('Bu bağlantı kimliği zaten tanımlı.');
  if (!baseUrl) throw new Error('API Base URL girin.');
  if (!modelNames.length) throw new Error('En az bir model kimliği girin.');
  const hostAdapter = protocol === 'anthropic' ? 'claude' : 'opencode';
  const cli = snapshot.installed.find(item => item.adapter === hostAdapter && item.executable);
  if (!cli) throw new Error(`${protocol} API yuvası için bilgisayarınızda ${hostAdapter} CLI kurulu olmalıdır.`);
  const route = {
    id, adapter: hostAdapter, executable: cli.executable, enabled: true, billing, trustedSettings: true,
    priority: billing === 'paid_api' ? 200 : 100, maxConcurrent: 1,
    api: { protocol, baseUrl, secretRef: id },
    models: modelNames.map(m => ({ id: m, alias: m, group: billing === 'free' ? 'free' : 'api', enabled: true, efforts: [], kinds: ['text', 'read', 'write'] })),
  };
  settings.config.routes.push(route);
  settings = await call('save', { ...settings, secrets: apiKey ? { [id]: apiKey } : {} });
  $('api-id').value = ''; $('api-base-url').value = ''; $('api-key').value = ''; $('api-models').value = '';
  renderSettings(); renderPool(); await refresh(); notice(`${id} API bağlantısı eklendi ve etkinleştirildi.`);
}));
$('add-custom-cli').addEventListener('click', () => void action(async () => {
  const id = $('custom-cli-id').value.trim();
  const executable = $('custom-cli-exe').value.trim();
  const argsTemplate = $('custom-cli-args').value.trim().split(/\s+/).filter(Boolean);
  const billing = $('custom-cli-billing').value;
  const modelNames = $('custom-cli-models').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Bağlantı kimliği yalnızca harf, rakam, tire ve alt çizgi içermelidir.');
  if (settings.config.routes.some(route => route.id === id)) throw new Error('Bu bağlantı kimliği zaten tanımlı.');
  if (!executable) throw new Error('Çalıştırılabilir dosya yolunu girin.');
  if (!argsTemplate.length) throw new Error('Argüman şablonunu girin.');
  if (!modelNames.length) throw new Error('En az bir model kimliği girin.');
  const route = {
    id, adapter: 'custom', executable, argsTemplate, promptStdin: !argsTemplate.some(a => a.includes('{prompt}')),
    enabled: false, billing, trustedSettings: true, priority: 100, maxConcurrent: 1,
    models: modelNames.map(m => ({ id: m, alias: m, group: 'custom', enabled: true, efforts: [], kinds: ['text', 'read', 'write'] })),
  };
  settings.config.routes.push(route);
  settings = await call('save', settings);
  $('custom-cli-id').value = ''; $('custom-cli-exe').value = ''; $('custom-cli-args').value = ''; $('custom-cli-models').value = '';
  renderSettings(); renderPool(); await refresh(); notice(`${id} özel CLI bağlantısı eklendi.`);
}));
$('task-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const request = selectionRequest();
    request.prompt = [$('task-prompt').value, $('task-goal').value.trim() ? `Hedef / tamamlanma koşulu:\n${$('task-goal').value.trim()}` : '', ...skills.map(skill => `Skill: ${skill.name}${skill.id ? `\nKaynak: ${skill.id}` : ''}\n${skill.text}`)].filter(Boolean).join('\n\n');
    request.workspace = $('task-workspace').value;
    request.timeoutSeconds = 300;
    if (request.prompt.length > 100000) throw new Error('Görev, hedef ve skill metni toplamı 100.000 karakteri aşamaz.');
    const fingerprint = JSON.stringify(request);
    if (submitted?.fingerprint !== fingerprint) submitted = { fingerprint, key: crypto.randomUUID() };
    const task = await call('submit', { ...request, idempotencyKey: submitted.key });
    await openTask(task.id); $('task-prompt').value = ''; $('task-goal').value = ''; skills = []; renderSkills(); $('task-instructions').open = false; updateSubmit(); await refresh(); notice('Görev kaydedildi. Durumu ve sonucu çalışma alanında güncellenir.');
  });
});

function selectionRequest() {
  const request = { kind: $('task-kind').value };
  if ($('task-group').value) request.group = $('task-group').value;
  if ($('task-model').value) { const [routeId, modelId, group] = JSON.parse($('task-model').value); Object.assign(request, { routeId, modelId }); if (group !== 'unassigned') request.group = group; }
  if ($('task-effort').value) request.effort = $('task-effort').value;
  return request;
}
function switchPage(page) {
  $('pool-panel').hidden = page !== 'pool'; $('workspace-panel').hidden = page !== 'workspace'; $('settings').hidden = page !== 'settings';
  if (page === 'pool') renderPool();
  if (page === 'settings' && settings) renderSettings();
  $('detail').close(); $('detail').hidden = true;
  for (const [id, target] of [['pool-tab', 'pool'], ['workspace-tab', 'workspace'], ['open-settings', 'settings']]) {
    if (page === target) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
}

document.querySelector('.skip').addEventListener('click', () => { switchPage('workspace'); $('task-prompt').focus(); updateSubmit(); });
$('pool-tab').addEventListener('click', () => switchPage('pool'));
$('workspace-tab').addEventListener('click', () => switchPage('workspace'));
$('task-group').addEventListener('change', updateModels);
$('task-model').addEventListener('change', () => { updateEfforts(); updateSubmit(); });
$('pool-search').addEventListener('input', () => { $('pool-models').scrollTop = 0; renderCatalog(); });
$('selection-mode').addEventListener('change', () => { settings.config.selectionMode = $('selection-mode').value; dirty(); renderPool(); });
$('grouping-mode').addEventListener('change', () => { settings.config.groupingMode = $('grouping-mode').value; dirty(); });
$('discard-settings').addEventListener('click', () => void action(async () => { settings = await call('settings'); poolDirty = false; baseConfig = structuredClone(settings.config); renderSettings(); renderPool(); updateSave(); }));
$('toggle-quotas').addEventListener('click', () => {
  quotasOpen = [...document.querySelectorAll('.quota-details')].some(node => !node.open);
  quotaStates.clear();
  document.querySelectorAll('.quota-details').forEach(node => { node.open = quotasOpen; });
  updateQuotaToggle(); rememberView();
});
function updateQuotaToggle() {
  const details = [...document.querySelectorAll('.quota-details')];
  const allOpen = details.length ? details.every(node => node.open) : quotasOpen;
  $('toggle-quotas').textContent = allOpen ? 'Kotaları gizle' : 'Kotaları göster';
  $('toggle-quotas').setAttribute('aria-pressed', String(allOpen));
}

function quotaBody(q, modelId = '', error) {
  const cell = element('div', null, 'quota-body');
  const windows = quotaWindows(q, modelId);
  for (const window of windows) {
    const name = ({ five_hour: '5 saat', seven_day: '7 gün', '5h': '5 saat', '7d': '7 gün', weekly: 'Haftalık', monthly: 'Aylık', opus: 'Opus haftalık', primary: 'Kısa dönem', secondary: 'Haftalık' })[window.name] || (window.windowMinutes ? window.windowMinutes >= 1440 ? `${window.windowMinutes / 1440} gün` : `${window.windowMinutes / 60} saat` : window.name);
    const line = element('div', null, 'usage-line');
    const heading = element('div', null, 'quota-heading'); heading.append(element('span', name), element('strong', `%${window.remaining.toFixed(0)} kalan`));
    const bar = document.createElement('progress'); bar.max = 100; bar.value = window.remaining; bar.setAttribute('aria-label', `${name} kalan kota`);
    line.append(heading, bar, element('small', `%${window.used.toFixed(0)} kullanıldı${window.resetsAt ? ` · Yenilenme: ${new Date(typeof window.resetsAt === 'number' && window.resetsAt < 1e12 ? window.resetsAt * 1000 : window.resetsAt).toLocaleString('tr-TR')}` : ''}`)); cell.append(line);
  }
  if (!windows.length) cell.append(element('p', error || (quotasRefreshing ? 'Kota sorgulanıyor…' : q?.status === 'auth_required' ? 'Giriş gerekli' : q ? 'Sağlayıcı yüzde kotası bildirmiyor' : 'Kota henüz sorgulanmadı'), 'hint'));
  if (windows.length) cell.append(element('small', `${q.scope === 'model' ? 'Model kotası' : 'Hesap kotası'}${q.observedAt ? ` · Ölçüm: ${new Date(q.observedAt).toLocaleTimeString('tr-TR')}` : ''}${Date.now() - Date.parse(q.observedAt) >= 60000 ? ' · eski ölçüm' : ''}${error ? ' · son sorgu başarısız' : ''}`, 'quota-stamp'));
  return cell;
}
function quotaCell(route, model) {
  const cell = element('div', null, 'quota-cell'); const q = snapshot?.quotas?.[route.id];
  const windows = quotaWindows(q, model.id); const details = element('details', null, 'quota-details'); const key = JSON.stringify([route.id, model.id]); details.dataset.quotaKey = key;
  details.open = quotaStates.has(key) ? quotaStates.get(key) : quotasOpen;
  const summary = element('summary'); summary.append(element('span', 'Kota'), element('strong', windows.length ? `%${Math.min(...windows.map(window => window.remaining)).toFixed(0)} kalan` : 'Bilinmiyor'));
  details.append(summary, quotaBody(q, model.id, quotaErrors[route.id]));
  details.addEventListener('toggle', () => { if (!details.isConnected) return; quotaStates.set(key, details.open); document.querySelectorAll('.quota-details').forEach(other => { if (other !== details && other.dataset.quotaKey === key) other.open = details.open; }); updateQuotaToggle(); rememberView(); });
  cell.append(details); return cell;
}
function renderPool() {
  if (!settings) return;
  $('selection-mode').value = settings.config.selectionMode;
  $('grouping-mode').value = settings.config.groupingMode;
  updateSave();
  $('group-summary').replaceChildren(...strengthGroups.map(group => {
    const count = settings.config.routes.reduce((total, route) => total + route.models.filter(model => !modelFiltered(settings.config.modelFilters, route.id, model.id) && memberships(model).some(member => member.group === group)).length, 0);
    const card = element('button', null, `group-card group-${group}`); card.type = 'button'; card.setAttribute('aria-pressed', String(selectedGroup === group));
    card.append(element('strong', groupLabel(group)), element('span', `${count} model`));
    card.addEventListener('click', () => { selectedGroup = group; rememberView(); renderPool(); }); return card;
  }));
  $('members-heading').textContent = `${groupLabel(selectedGroup)} üyeleri`;
  $('filter-count').textContent = settings.config.modelFilters?.length || 0;
  const memberScroll = $('pool-members').scrollLeft, memberTop = $('pool-members').scrollTop;
  const rows = [];
  const entries = sortModels(settings.config.routes.flatMap(route => route.models.filter(model => !modelFiltered(settings.config.modelFilters, route.id, model.id)).map(model => ({route, model}))), 'az', $('member-view').value === 'family');
  if ($('member-view').value === 'route') entries.sort((a,b) => a.route.id.localeCompare(b.route.id));
  for (const {route,model} of entries) {
    const member = memberships(model).find(item => item.group === selectedGroup);
    if (!member) continue;
    rows.push(modelCard(route,model,member));
  }
  $('pool-members').replaceChildren(...(rows.length ? rows : [element('p', `Bu havuz boş. Aşağıdan Codex, Claude veya başka bir araç seçip modelleri ekleyin.`, 'empty')]));
  $('pool-members').scrollLeft = memberScroll; $('pool-members').scrollTop = memberTop;
  renderCatalog();
}
async function refreshCatalog(routeId) {
  // A live refresh is merged through the same scan path so unsaved owner choices survive.
  if (poolDirty) { await runScanImport(routeId); return; }
  settings = await call('refresh_catalog', { routeId }); renderPool(); await refresh(); notice('Model sürümleri güncellendi.');
}
function familyLabel(value) { return ({sol:'Sol',terra:'Terra',astra:'Astra',luna:'Luna',opus:'Opus',sonnet:'Sonnet',haiku:'Haiku',gemini:'Gemini',qwen:'Qwen',glm:'GLM',gpt:'GPT','gpt-oss':'GPT OSS'})[value] || value; }
function renderCatalog() {
  if (!settings) return;
  const scroll = $('pool-models').scrollTop;
  const routes = settings.config.routes;
  const all = routes.flatMap(route => route.models.filter(model => !modelFiltered(settings.config.modelFilters, route.id, model.id)).map(model => ({route,model})));
  const byFamily = $('catalog-view').value === 'family';
  if (!routes.some(route => route.id === selectedRoute)) selectedRoute = routes.find(route => route.adapter === 'codex')?.id || routes[0]?.id || '';
  const families = [...new Set(all.map(({model}) => modelFamily(model.id)))].sort();
  if (!families.includes(selectedFamily)) selectedFamily = families[0] || '';
  const groups = byFamily ? families.map(id => ({id,label:familyLabel(id),count:all.filter(({model})=>modelFamily(model.id)===id).length})) : routes.map(route => ({id:route.id,label:`${adapterLabels[route.adapter] || route.adapter}${route.api ? ' API' : ''}`,count:all.filter(item=>item.route.id===route.id).length}));
  $('route-nav').replaceChildren(...groups.map(group => {
    const node = element('button', `${group.label} (${group.count})`); node.type='button'; node.title=group.id;
    const selected = group.id === (byFamily ? selectedFamily : selectedRoute); node.classList.toggle('selected',selected); node.setAttribute('aria-pressed',String(selected));
    node.addEventListener('click',()=>{ if (byFamily) selectedFamily=group.id; else selectedRoute=group.id; rememberView(); $('pool-search').value=''; $('pool-models').scrollTop=0; renderCatalog(); }); return node;
  }));
  const route = routes.find(route=>route.id===selectedRoute);
  const status = element('div',null,'actions');
  if (byFamily) status.append(element('small',`${familyLabel(selectedFamily)} · Tüm bağlantılar; her abonelik ayrı seçilebilir.`));
  else if (route) {
    status.append(element('small',`${route.id} · ${billingLabels[route.billing]}${route.api ? ` · ${route.api.baseUrl}` : ['ollama','lmstudio'].includes(route.adapter) ? ' · Yerel modeller' : ''}`));
    status.append(loginNotice(route));
    if (route.adapter !== 'codex' && !route.api && route.billing !== 'free' && !route.trustedSettings) {
      const label=element('label',null,'trust-field'), check=document.createElement('input'); check.type='checkbox'; check.checked=route.trustedSettings;
      check.addEventListener('change',()=>{route.trustedSettings=check.checked;dirty();});label.append(check,element('span','Yerel ayarları ve planı doğruladım'));status.append(label);
    }
  }
  $('catalog-status').replaceChildren(status);
  const search=$('pool-search').value.trim().toLocaleLowerCase('tr');
  const entries=sortModels(all.filter(({route,model})=>(byFamily ? modelFamily(model.id)===selectedFamily : route.id===selectedRoute) && `${model.id} ${model.alias} ${route.id}`.toLocaleLowerCase('tr').includes(search)), $('catalog-sort').value, byFamily);
  $('pool-models').replaceChildren(...entries.map(({route,model})=>modelCard(route,model)));
  if(!entries.length) $('pool-models').append(element('p','Görünür model yok. Filtreleri kontrol edin veya Ayarlar → Modelleri tara seçeneğini kullanın.','empty'));
  $('catalog-count').textContent=`${entries.length} model`;$('pool-models').scrollTop=scroll;updateQuotaToggle();
}
function modelCard(route,model,member) {
  const row=element('div',null,`model-card ${member?'membership-row':'catalog-row'}`), info=element('div',null,'model-info');
  row.setAttribute('role','group');row.setAttribute('aria-label',`${model.id} · ${route.id}`);row.dataset.routeId=route.id;row.dataset.modelId=model.id;
  info.append(element('strong',model.id),element('small',`${adapterLabels[route.adapter] || route.adapter} · ${route.id}`));info.title=`${model.id} · ${route.id}`;
  if(model.enabled===false || !route.enabled) info.append(element('small','Kullanımı kapalı','version-unknown'));
  if(!/\d/.test(model.id)) info.append(element('small','Sağlayıcı sürüm bildirmedi','version-unknown'));
  const footer=element('div',null,'model-footer');
  if(member) {
    const effort=settingField('Efor',member.effort||'',value=>{model.memberships=memberships(model);const item=model.memberships.find(item=>item.group===selectedGroup);if(value)item.effort=value;else delete item.effort;dirty();},['',...model.efforts]);
    effort.querySelector('select').setAttribute('aria-label',`${model.id} · ${route.id} efor`);
    const remove=button('Çıkar',async()=>{model.memberships=memberships(model).filter(item=>item.group!==selectedGroup);dirty();renderPool();});remove.setAttribute('aria-label',`${model.id} · ${route.id} modelini ${groupLabel(selectedGroup)} havuzundan çıkar`);footer.append(effort,remove);
  } else {
    const groups=memberships(model);footer.append(element('small',groups.length?groups.map(item=>groupLabel(item.group)).join(' · '):'Henüz bir havuzda değil','model-memberships'));
    const actions=element('div',null,'model-actions'), hide=button('Gizle',async()=>openFilters(route,model)), add=button('Ekle',async()=>openPoolPicker(route,model));
    hide.setAttribute('aria-label',`${model.id} için filtre ekle`);add.classList.add('add-model');add.dataset.modelId=model.id;add.dataset.routeId=route.id;add.setAttribute('aria-label',`${model.id} modelini havuza ekle`);actions.append(hide,add);footer.append(actions);
  }
  row.append(info,quotaCell(route,model),footer,loginNotice(route));return row;
}
function openFilters(route, model) {
  const filters=settings.config.modelFilters ||= [];
  $('filter-actions').replaceChildren();
  if(route&&model) {
    $('filter-heading').textContent=model.id;
    const rules=[['Bu bağlantıda gizle',{match:'model',value:model.id,routeId:route.id}],['Bu modeli her yerde gizle',{match:'model',value:modelIdentity(model.id)}],[`${familyLabel(modelFamily(model.id))} ailesini gizle`,{match:'family',value:modelFamily(model.id)}]];
    for(const [label,rule] of rules) $('filter-actions').append(button(label,async()=>{if(!filters.some(item=>JSON.stringify(item)===JSON.stringify(rule))){filters.push(rule);dirty();}renderPool();openFilters();}));
  } else $('filter-heading').textContent='Gizlenen modeller';
  $('filter-list').replaceChildren(...filters.map((rule,index)=>{const row=element('div',null,'filter-row');row.append(element('span',`${rule.match==='family'?familyLabel(rule.value)+' ailesi':rule.value} · ${rule.routeId||'Tüm bağlantılar'}`),button('Göster',async()=>{filters.splice(index,1);dirty();renderPool();openFilters();}));return row;}));
  if(!filters.length) $('filter-list').append(element('p','Gizlenen model yok. Model kartındaki Gizle düğmesiyle filtre ekleyin.','hint'));
  if(!$('model-filter-dialog').open) $('model-filter-dialog').showModal(); else $('close-filters').focus();
}
$('open-filters').addEventListener('click',()=>openFilters());
$('close-filters').addEventListener('click',()=>$('model-filter-dialog').close());
$('model-filter-dialog').addEventListener('close',()=>$('open-filters').focus());
function loginNotice(route) {
  const q=snapshot?.quotas?.[route.id], box=element('div',null,'login-notice');
  if(q?.status!=='auth_required') return box;
  box.append(element('span','Giriş gerekli'));
  box.append(button(route.api?'Anahtar ayarları':'Giriş yap',async()=>{if(route.api){switchPage('settings');return;}const result=await call('login',{routeId:route.id});notice(result.message);}));
  box.append(button('Kontrol et',async()=>{await refreshQuotas(route.id);await refresh();renderPool();}));return box;
}
function openPoolPicker(route, model) {
  pendingPoolModel = { routeId: route.id, modelId: model.id };
  $('add-pool-model').textContent = model.id;
  $('add-pool-effort').replaceChildren(...(memberships(model).length ? [new Option('Mevcut eforu koru', 'preserve')] : []), new Option('CLI varsayılanı', ''), ...model.efforts.map(effort => new Option(effortLabel(effort), effort)));
  $('add-pool-targets').replaceChildren(...strengthGroups.map(group => {
    const existing = memberships(model).find(member => member.group === group);
    return button(`${groupLabel(group)}${existing ? ' · ekli' : ''}`, async () => {
      const targetRoute = settings.config.routes.find(item => item.id === pendingPoolModel?.routeId);
      const targetModel = targetRoute?.models.find(item => item.id === pendingPoolModel?.modelId);
      if (!targetModel) throw new Error('Model kataloğu değişti. Modeli yeniden seçin.');
      if (!activeBillings.has(targetRoute.billing)) throw new Error('Bağlantı ayarlarından bu aracın plan türünü doğrulayın.');
      const member = memberships(targetModel).find(item => item.group === group);
      const changed = addMembership(targetModel, group, $('add-pool-effort').value === 'preserve' ? member?.effort || '' : $('add-pool-effort').value);
      const enabled = targetModel.enabled && targetRoute.enabled;
      targetModel.enabled = true; targetRoute.enabled = true; if (changed || !enabled) dirty(); $('add-pool-dialog').close(); renderPool();
      [...$('pool-models').querySelectorAll('.add-model')].find(node => node.dataset.modelId === targetModel.id && node.dataset.routeId === targetRoute.id)?.focus();
      notice(`${targetModel.id}, ${groupLabel(group)} havuzunda.${snapshot?.quotas?.[targetRoute.id]?.status === 'auth_required' ? ' Kullanmak için Giriş yap düğmesiyle oturum açın.' : ''}`);
    });
  }));
  $('add-pool-dialog').showModal();
}
$('close-add-pool').addEventListener('click', () => $('add-pool-dialog').close());
$('add-pool-dialog').addEventListener('close', () => { pendingPoolModel = null; });
async function refreshQuotas(routeId) {
  if (quotasRefreshing) return;
  quotasRefreshing = true; $('refresh-quotas').textContent = 'Limitler sorgulanıyor…'; renderPool();
  try {
    const result = await call('quotas', { ...(routeId ? { routeId } : {}), force: true }); snapshot.quotas = { ...snapshot.quotas, ...result.quotas }; quotaErrors = routeId ? { ...quotaErrors, [routeId]: result.errors[routeId] } : result.errors;
  } catch (error) { notice(error.message, true); }
  finally { quotasRefreshing = false; $('refresh-quotas').textContent = 'Kotaları yenile'; renderPool(); }
}
$('refresh-quotas').addEventListener('click', () => { void refreshQuotas(); });
function rememberProject(root) {
  $('task-workspace').value=root;
  try { localStorage.setItem('pool-project',root); } catch { /* Selection works without persistence. */ }
  selectedTask=null;selectedTaskStamp='';conversationRoot=null;$('conversation').replaceChildren();
}
function renderProjects() {
  const roots = snapshot?.workspaceRoots || [];
  const root = $('task-workspace').value; $('browse-workspace').textContent = root ? root.split(/[\\/]/).filter(Boolean).at(-1) : 'Proje seç'; $('browse-workspace').title = root || 'Proje klasörü seçin';
  $('projects').replaceChildren(...roots.map(root => {
    const node = button(root.split(/[\\/]/).filter(Boolean).at(-1) || root, async () => { rememberProject(root); renderProjects(); await refresh(); });
    node.title = root; node.className = 'project-button'; node.classList.toggle('selected', root === $('task-workspace').value); return node;
  }));
}
async function openFolders() {
  notice('Windows klasör seçme penceresi açılıyor…');
  const result = await call('pick_folder', { path: $('task-workspace').value || '' });
  if (!result.path) { notice('Klasör seçimi iptal edildi.'); return; }
  // Save only the selected project root, keeping any unrelated pool draft in memory.
  const view = await call('settings');
  if (!view.config.workspaceRoots.includes(result.path)) view.config.workspaceRoots.push(result.path);
  const saved = await call('save', view);
  if (settings && poolDraft) { settings.config.workspaceRoots = [...new Set([...settings.config.workspaceRoots, result.path])]; settings.revision = saved.revision; poolDirty = true; }
  else settings = saved;
  rememberProject(result.path); await refresh(); renderPool(); notice('Proje klasörü seçildi.');
}
let poolDraft = false;
function chooseWindowsFolder() { poolDraft = poolDirty; void action(openFolders); }
$('browse-workspace').addEventListener('click', chooseWindowsFolder);
$('add-project').addEventListener('click', chooseWindowsFolder);
async function openTask(id, force = true) {
  const summary = snapshot?.tasks.find(task => task.id === id);
  const stamp = `${id}:${summary?.updated}`;
  if (!force && stamp === selectedTaskStamp) return;
  const task = await call('task', { taskId: id }); selectedTask = id; selectedTaskStamp = stamp;
  const content=[];
  const meta=element('details',null,'message-meta');meta.append(element('summary',`${adapterLabels[snapshot?.connections.find(route=>route.id===task.routeId)?.adapter] || task.routeId} · ${task.modelId} · ${labels[task.state]}`),element('p',`${task.routeId} · ${groupLabel(task.group || 'unassigned')} · Efor: ${effortLabel(task.effort)}${task.reportedModel ? ` · Bildirilen: ${task.reportedModel}` : ''}`));
  if(task.prompt) content.push(element('div',task.prompt.split(/\n\n(?:Hedef \/ tamamlanma koşulu:|Skill:)/)[0],'user-message'));
  content.push(element('div',task.result || task.error || task.events?.at(-1)?.detail || labels[task.state],'agent-message'),meta);
  const existing=[...$('conversation').children].find(node=>node.dataset.taskId===task.id), nearBottom=$('conversation').scrollHeight-$('conversation').scrollTop-$('conversation').clientHeight<60;
  const article=element('article',null,'message-pair');article.dataset.taskId=task.id;article.append(...content);
  if(existing)existing.replaceWith(article);else{$('conversation').querySelector('.empty')?.remove();$('conversation').append(article);}
  if(force || nearBottom) $('conversation').scrollTop=$('conversation').scrollHeight;
}
let availableSkills=[];
async function openSkillPicker(query='') {
  $('skill-search').value=query;$('skill-list').replaceChildren(element('p','Skill’ler yükleniyor…','hint'));
  if(!$('skill-dialog').open)$('skill-dialog').showModal();$('skill-search').focus();
  try { availableSkills=await call('skills',{workspace:$('task-workspace').value});renderSkillPicker(); } catch(error){$('skill-list').replaceChildren(element('p',error.message,'hint'));}
}
function renderSkillPicker(){
  const query=$('skill-search').value.toLocaleLowerCase('tr');
  $('skill-list').replaceChildren(...availableSkills.filter(skill=>`${skill.name} ${skill.description}`.toLocaleLowerCase('tr').includes(query)).map(skill=>{
    const item=button('',async()=>{if(skills.length>=10)throw Error('Bir mesaja en fazla 10 skill ekleyebilirsiniz.');if(!skills.some(item=>item.id===skill.id)){const attached=await call('skill',{workspace:$('task-workspace').value,id:skill.id});skills.push(attached);renderSkills();}if(/^\/[^\s]*$/.test($('task-prompt').value))$('task-prompt').value='';$('skill-dialog').close();$('task-prompt').focus();updateSubmit();});item.append(element('strong',skill.name),element('small',`${skill.source}${skill.description ? ` · ${skill.description}`:''}`));return item;
  }));
  if(!$('skill-list').children.length)$('skill-list').append(element('p','Eşleşen skill yok. Projenizde .agents/skills/<ad>/SKILL.md kullanabilir veya dosyadan ekleyebilirsiniz.','hint'));
}
$('attach-instructions').addEventListener('click',()=>void openSkillPicker());
$('task-prompt').addEventListener('input',()=>{if(/^\/[^\s]*$/.test($('task-prompt').value))void openSkillPicker($('task-prompt').value.slice(1));});
$('skill-search').addEventListener('input',renderSkillPicker);
$('close-skills').addEventListener('click',()=>$('skill-dialog').close());
$('skill-dialog').addEventListener('close',()=>$('task-prompt').focus());
$('upload-skill').addEventListener('click',()=>{$('skill-dialog').close();$('skill-files').click();});
$('add-goal').addEventListener('click',()=>{$('skill-dialog').close();$('task-instructions').open=true;$('task-goal').focus();});
$('new-task').addEventListener('click', () => { selectedTask = null; selectedTaskStamp = ''; submitted = null; $('task-prompt').value = ''; $('task-goal').value = ''; skills = []; renderSkills(); $('conversation').replaceChildren(); $('task-prompt').focus(); updateSubmit(); });
$('preview-selection').addEventListener('click', () => void action(async () => {
  const result = await call('select', selectionRequest()); await refresh();
  const rows = [result.selected, ...result.alternatives].map((model, index) => element('p', `${index ? 'Alternatif' : 'Seçilen'}: ${model.alias} · ${model.routeId} · ${groupLabel(model.group)}`));
  $('conversation').replaceChildren(...rows, element('p', result.reason, 'hint'));
}));
function renderSkills() {
  $('attached-skills').replaceChildren(...skills.map((skill, index) => button(`${skill.name} ×`, async () => { skills.splice(index, 1); renderSkills(); })));
  $('skill-files').value = '';
}
$('skill-files').addEventListener('change', () => void action(async () => {
  const additions = [];
  for (const file of $('skill-files').files) {
    if (!file.name.toLowerCase().endsWith('.md') || file.size > 65536) throw new Error('Her skill .md dosyası olmalı ve en fazla 64 KB olabilir.');
    additions.push({ name: file.name, text: await file.text() });
  }
  if (skills.length + additions.length > 10) throw new Error('Bir göreve en fazla 10 skill ekleyebilirsiniz.');
  skills.push(...additions); renderSkills();
}));
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition(); recognition.lang = 'tr-TR'; recognition.interimResults = false;
  recognition.onresult = event => { $('task-prompt').value += `${$('task-prompt').value ? ' ' : ''}${event.results[0][0].transcript}`; updateSubmit(); };
  recognition.onerror = event => { const reason = ({ 'not-allowed': 'Mikrofon izni verilmedi', 'audio-capture': 'Mikrofon bulunamadı', network: 'Konuşma tanıma hizmetine ulaşılamadı', 'no-speech': 'Ses algılanmadı' })[event.error] || 'Sesle yazma kullanılamadı'; $('voice-status').textContent = `${reason}. Komutunuzu yazarak girebilirsiniz.`; };
  recognition.onend = () => { $('voice-input').classList.remove('listening'); $('voice-input').setAttribute('aria-label', 'Sesle yaz'); $('voice-input').setAttribute('aria-pressed', 'false'); updateSubmit(); if ($('voice-status').textContent.startsWith('Dinleniyor')) $('voice-status').textContent = 'Sesle yazma tamamlandı. Metni kontrol edip gönderebilirsiniz.'; };
  $('voice-input').addEventListener('click', () => {
    if ($('voice-input').getAttribute('aria-pressed') === 'true') { recognition.stop(); return; }
    try { recognition.start(); $('voice-input').classList.add('listening'); $('voice-input').setAttribute('aria-label', 'Dinlemeyi durdur'); $('voice-input').setAttribute('aria-pressed', 'true'); updateSubmit(); $('voice-status').textContent = 'Dinleniyor… Sesiniz tarayıcınızın konuşma tanıma hizmetiyle metne çevrilir.'; }
    catch (error) { notice(error.message, true); }
  });
} else { $('voice-input').disabled = true; $('voice-input').dataset.locked = 'true'; $('voice-status').textContent = 'Bu tarayıcı sesle yazmayı desteklemiyor. Destekleyen bir Chrome / Edge sürümüyle açabilirsiniz.'; }
window.addEventListener('beforeunload', event => { if (poolDirty) { event.preventDefault(); event.returnValue = ''; } });
void refresh(true).then(() => { if (snapshot) void refreshQuotas(); });
setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 5000);

setInterval(() => { if (!document.hidden && snapshot && !busy) void refreshQuotas(); }, 60000);
