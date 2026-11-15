import { categoriesOf, isCategoryId, removeCategory } from '/categories.js';
import {
  memberships,
  visibleRoutes,
  mergeScanDraft,
  addMembership,
  modelSaveConfig,
  batchModelSaveConfig,
  preferenceSaveConfig,
  quotaWindows,
  quotaWindowPercent,
  modelIssueInfo,
  quotaMatches,
  effortLabel,
  modelIdentity,
  modelFamily,
  modelFiltered,
  isSettingsFiltered,
  setRouteModelSettingsFilter,
  unhideModels,
  sortModels,
  cleanRouteLabel,
  toolGroupsForRoutes,
  filterHierarchy,
  settingsViewSignature,
  quotaToggleState,
  quotaToggleTarget,
} from '/pool-state.js';
import { dismissOnBackdrop } from '/dialogs.js';
import { capabilityLabel } from '/capabilities.js';

const $ = id => document.getElementById(id);
document.querySelectorAll('dialog').forEach(dismissOnBackdrop);

const labels = {
  queued: 'Sırada',
  starting: 'Başlatılıyor',
  running: 'Çalışıyor',
  succeeded: 'Tamamlandı',
  failed: 'Başarısız',
  timed_out: 'Süre doldu',
  cancelling: 'Durduruluyor',
  cancelled: 'Durduruldu',
  needs_review: 'Elle inceleme gerekli',
};
const billingLabels = {
  subscription: 'Abonelik',
  token_plan: 'Token planı',
  free_credits: 'Günlük / ücretsiz kredi',
  free: 'Ücretsiz',
  paid_api: 'Ücretli API',
  unknown: 'Doğrulanmadı',
};
const activeBillings = new Set(['subscription', 'token_plan', 'free_credits', 'free', 'paid_api']);
const adapterLabels = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  qwen: 'Qwen',
  mcode: 'MiniMax Code',
  mmx: 'MiniMax CLI',
  kimi: 'Kimi',
  mimo: 'MiMo',
  qoder: 'Qoder',
  agy: 'Antigravity',
  omniroute: 'OmniRoute',
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
  hermes: 'Hermes',
  aider: 'Aider',
  kilocode: 'Kilo',
  custom: 'Özel araç',
};
const groupLabels = {
  __all__: 'Tümünü Göster',
  high: 'Yüksek',
  medium: 'Orta',
  low: 'Hafif',
  free: 'Ücretsiz',
  unassigned: 'Sınıflandırılmamış',
};
const categoryPresetDefs = [
  { id: 'coding', name: 'Kodlama' },
  { id: 'fast', name: 'Hızlı' },
  { id: 'reasoning', name: 'Analiz' },
  { id: 'vision', name: 'Görsel / Çoklu ortam' },
  { id: 'backup', name: 'Yedek' },
];
const activeStates = new Set(['queued', 'starting', 'running', 'cancelling']);
const accountWaits = new Set();
const accountAdapters = new Set(['codex', 'claude', 'agy', 'zcode', 'qwen', 'kimi', 'mcode', 'mmx', 'qoder', 'mimo']);

let snapshot = null;
let settings = null;
let baseConfig = null;
let busy = false;
let refreshing = false;
let serviceStopped = false;
let selectedTask = null;
let selectedTaskStamp = '';
let poolDirty = false;
let selectedRoute = '';
let selectedGroup = '__all__';
let selectedPoolSubgroup = '';
let selectedHiddenSubgroup = '';
let selectedHiddenReason = '__all__';
let poolNav = { tool: '__all__', routeId: '__all__', family: '__all__' };
let catalogNav = { tool: '__all__', routeId: '__all__', family: '__all__' };
let hiddenNav = { tool: '__all__', routeId: '__all__', family: '__all__' };
let selectedSettingsTool = '';
const selectedSettingsRoute = new Map();
const routeModelsFamily = new Map();
let quotasOpen = true;
const quotaStates = new Map();
let noticeTimer;
let selectedFamily = '';
let selectedEmail = '';
let showDisabledRoutes = false;
let quotasRefreshing = false;
let quotaErrors = {};
let pendingPoolModel = null;
let pendingPoolBatch = null;
const selectedPoolItems = new Set();
const selectedCatalogItems = new Set();
const selectedHiddenItems = new Set();
let categoryEditorStamp = '';
let dragPayload = null;
let refreshIntervalId = null;
let quotaIntervalId = null;
let catalogIntervalId = null;
let catalogSyncing = false;
const routeModelsSearch = new Map();

let viewPreferences = {};
try {
  viewPreferences = JSON.parse(localStorage.getItem('pool-view') || '{}');
  if (!viewPreferences || typeof viewPreferences !== 'object' || Array.isArray(viewPreferences)) viewPreferences = {};
} catch { /* Browser defaults remain usable. */ }

const validNavState = obj => ({
  tool: typeof obj?.tool === 'string' && obj.tool ? obj.tool : '__all__',
  routeId: typeof obj?.routeId === 'string' && obj.routeId ? obj.routeId : '__all__',
  family: typeof obj?.family === 'string' && obj.family ? obj.family : '__all__',
});
selectedRoute = typeof viewPreferences.selectedRoute === 'string' ? viewPreferences.selectedRoute : '';
selectedFamily = typeof viewPreferences.selectedFamily === 'string' ? viewPreferences.selectedFamily : '';
selectedEmail = typeof viewPreferences.selectedEmail === 'string' ? viewPreferences.selectedEmail : '';
selectedPoolSubgroup = typeof viewPreferences.selectedPoolSubgroup === 'string' ? viewPreferences.selectedPoolSubgroup : '';
selectedHiddenSubgroup = typeof viewPreferences.selectedHiddenSubgroup === 'string' ? viewPreferences.selectedHiddenSubgroup : '';
selectedHiddenReason = typeof viewPreferences.selectedHiddenReason === 'string' && viewPreferences.selectedHiddenReason ? viewPreferences.selectedHiddenReason : '__all__';
selectedSettingsTool = typeof viewPreferences.selectedSettingsTool === 'string' ? viewPreferences.selectedSettingsTool : '';
poolNav = validNavState(viewPreferences.poolNav);
catalogNav = validNavState(viewPreferences.catalogNav);
hiddenNav = validNavState(viewPreferences.hiddenNav);
if (viewPreferences.selectedSettingsRoute && typeof viewPreferences.selectedSettingsRoute === 'object') {
  for (const [k, v] of Object.entries(viewPreferences.selectedSettingsRoute)) {
    if (typeof v === 'string' && v) selectedSettingsRoute.set(k, v);
  }
}
if (viewPreferences.selectedGroup === '__all__' || isCategoryId(viewPreferences.selectedGroup)) {
  selectedGroup = viewPreferences.selectedGroup;
}
if (typeof viewPreferences.quotasOpen === 'boolean') quotasOpen = viewPreferences.quotasOpen;
if (typeof viewPreferences.showDisabledRoutes === 'boolean') showDisabledRoutes = viewPreferences.showDisabledRoutes;
for (const [key, value] of Object.entries(viewPreferences.quotaStates || {})) {
  if (typeof value === 'boolean') quotaStates.set(key, value);
}

function rememberView() {
  try {
    localStorage.setItem('pool-view', JSON.stringify({
      ...viewPreferences,
      selectedRoute,
      selectedFamily,
      selectedEmail,
      selectedGroup,
      selectedPoolSubgroup,
      selectedHiddenSubgroup,
      selectedHiddenReason,
      selectedSettingsTool,
      selectedSettingsRoute: Object.fromEntries(selectedSettingsRoute),
      poolNav,
      catalogNav,
      hiddenNav,
      showDisabledRoutes,
      quotasOpen,
      quotaStates: Object.fromEntries(quotaStates),
    }));
  } catch { /* Current-page choices still work. */ }
}

const persistedSelectIds = [
  'catalog-view',
  'catalog-sort',
  'member-view',
  'member-billing-filter',
  'member-sort',
  'quota-filter',
  'billing-filter',
  'hidden-view',
  'hidden-sort',
];
for (const id of persistedSelectIds) {
  const control = $(id);
  if (!control) continue;
  if ([...control.options].some(option => option.value === viewPreferences[id])) control.value = viewPreferences[id];
  control.addEventListener('change', () => {
    viewPreferences[id] = control.value;
    if (id === 'member-view') selectedPoolSubgroup = '';
    if (id === 'hidden-view') { selectedHiddenSubgroup = ''; selectedHiddenItems.clear(); }
    rememberView();
    if ($('pool-models')) $('pool-models').scrollTop = 0;
    renderPool();
  });
}

function updateDisabledToggle() {
  const btn = $('toggle-disabled-routes');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(showDisabledRoutes));
  btn.textContent = showDisabledRoutes ? 'Kapalıları gizle' : 'Kapalıları da göster';
}
updateDisabledToggle();
$('toggle-disabled-routes')?.addEventListener('click', () => {
  showDisabledRoutes = !showDisabledRoutes;
  updateDisabledToggle();
  rememberView();
  renderPool();
});

function setPanel(name, open) {
  const content = $(`${name}-content`), toggle = $(`toggle-${name}`), area = $(`${name}-area`);
  if (!content || !toggle || !area) return;
  content.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  area.classList.toggle('collapsed', !open);
  if (name === 'catalog' || name === 'pool') {
    $('pool-panel').classList.toggle('catalog-closed', $('catalog-content').hidden);
  }
}
for (const name of ['pool', 'catalog', 'hidden']) {
  const defaultOpen = name === 'hidden' ? viewPreferences[name] === true : viewPreferences[name] !== false;
  setPanel(name, defaultOpen);
  $(`toggle-${name}`)?.addEventListener('click', () => {
    const open = $(`${name}-content`).hidden;
    setPanel(name, open);
    viewPreferences[name] = open;
    rememberView();
  });
}

function routeEmail(routeId) {
  const fromSnap = snapshot?.quotas?.[routeId]?.email || snapshot?.connections?.find(c => c.id === routeId)?.email;
  if (fromSnap) return fromSnap;
  return settings?.config?.routes?.find(r => r.id === routeId)?.email || '';
}

function emailsMap() {
  const map = {};
  for (const route of settings?.config?.routes || []) {
    const mail = routeEmail(route.id);
    if (mail) map[route.id] = mail;
  }
  return map;
}

function categoryNamesMap() {
  const map = { ...groupLabels };
  for (const cat of categoriesOf(settings?.config || {})) map[cat.id] = cat.name;
  return map;
}

function sortContext(group = selectedGroup) {
  return {
    quotas: snapshot?.quotas || {},
    emails: emailsMap(),
    quotaErrors,
    group,
    categoryNames: categoryNamesMap(),
  };
}

const poolGroups = () => categoriesOf(settings?.config || {}).map(category => category.id);
const isAllGroup = group => group === '__all__';
const groupLabel = group => {
  if (group === '__all__') return groupLabels.__all__;
  return settings?.config.categories?.find(category => category.id === group)?.name || groupLabels[group] || group;
};
const activeRoutesForDisplay = () => {
  if (!settings?.config) return [];
  const includeDisabled = showDisabledRoutes || $('quota-filter')?.value === 'disabled';
  return includeDisabled ? settings.config.routes : visibleRoutes(settings.config);
};
function billingMatches(route, model, filter) {
  if (!filter || filter === 'all') return true;
  const billing = model.billing || route.billing;
  if (filter === 'free') return billing === 'free' || billing === 'free_credits';
  if (filter === 'paid') return billing === 'paid_api';
  return billing === filter;
}

try { $('theme').value = localStorage.getItem('pool-theme-v2') || 'dark'; } catch { /* Storage may be disabled. */ }
function applyTheme() {
  const theme = ['light', 'dark', 'system'].includes($('theme').value) ? $('theme').value : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
}
applyTheme();
$('theme').addEventListener('change', () => {
  applyTheme();
  try { localStorage.setItem('pool-theme-v2', $('theme').value); } catch { /* Current-page theme still works. */ }
});

function updateSave() {
  $('save-pool').hidden = !poolDirty;
  $('save-pool').disabled = busy || !poolDirty;
  $('save-pool').dataset.locked = String(!poolDirty);
  $('discard-settings').hidden = !poolDirty;
  try {
    if (poolDirty && baseConfig && settings) localStorage.setItem('pool-draft', JSON.stringify({ base: baseConfig, config: settings.config }));
    else localStorage.removeItem('pool-draft');
  } catch { /* Saving to the service remains available without browser storage. */ }
}
function dirty() { poolDirty = true; updateSave(); }

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function notice(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('error', error);
  if (!error) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}

async function call(operation, payload = {}) {
  const controller = new AbortController();
  const timeout = operation === 'pick_folder'
    ? 185_000
    : ['scan_import', 'quotas', 'update_service'].includes(operation) ? 90_000 : 30_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch('/ui', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, payload }),
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || 'İşlem tamamlanamadı. Yeniden deneyin.');
    if (operation === 'save') {
      poolDirty = false;
      updateSave();
      baseConfig = structuredClone(value.config);
    }
    if (operation === 'settings' && !poolDirty) baseConfig = structuredClone(value.config);
    return value;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') {
      throw new Error('Havuza ulaşılamıyor. Servisi kontrol edip yeniden deneyin; görev tanımınız korunuyor.');
    }
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
    updateSave();
  }
}

function showDetail(value) {
  $('detail-heading').textContent = value.windows ? 'Kota bilgisi' : 'Çağrı bilgisi';
  $('detail-content').replaceChildren(...(value.windows ? [quotaBody(value)] : taskDetails(value)));
  $('detail').hidden = false;
  if (!$('detail').open) $('detail').showModal();
  $('detail-heading').tabIndex = -1;
  $('detail-heading').focus();
}

function button(text, operation) {
  const node = element('button', text);
  node.type = 'button';
  node.disabled = busy;
  node.addEventListener('click', () => void action(operation));
  return node;
}

function formatQuotaSummary(conn, q) {
  const text = formatQuotaText(conn, q);
  return q?.note && !text.includes(q.note) ? `${text} · ${q.note}` : text;
}

function formatQuotaText(conn, q) {
  if (!q) return conn.protocol ? `${conn.protocol.toUpperCase()} API · ${conn.baseUrl}` : `Giriş komutu: ${conn.loginCommand || conn.adapter}`;
  if (q.status === 'unknown' && !q.windows?.length) return 'Kota bilgisi bu bağlantıda bilinmiyor';
  if (q.status === 'auth_required') return `Giriş gerekli: terminalde "${q.loginCommand || conn.loginCommand}" çalıştırın`;
  if (q.windows?.length) {
    return q.windows.map(w => `${w.bucketId ? `${w.bucketId} / ` : ''}${w.name}: ${Number.isFinite(w.remainingPercent) ? `%${w.remainingPercent} kalan` : 'kalan bilinmiyor'}${w.resetsAt ? ` · Yenilenme: ${new Date(typeof w.resetsAt === 'number' && w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt).toLocaleString('tr-TR')}` : ''}`).join(' · ');
  }
  if (q.subscription === 'active') return 'Etkin token planı doğrulandı';
  if (q.subscription === 'none' && conn.billing === 'free_credits') return 'Token planı yok · Günlük / ücretsiz kredi modu etkin';
  if (q.subscription === 'none') return 'Etkin token planı yok (günlük kredi için free_credits seçin)';
  if (q.endpoint) return `Uç nokta: ${q.endpoint}`;
  if (q.status === 'available' && q.note) return q.note;
  return `Durum: ${q.status}${q.auth ? ` (${q.auth})` : ''}`;
}

async function autoSyncCatalogs({ showErrors = false, refreshAfter = true, ignoreBusy = false } = {}) {
  if (catalogSyncing || serviceStopped || (!ignoreBusy && busy)) return null;
  if (!ignoreBusy && poolDirty) return null;
  catalogSyncing = true;
  try {
    const before = structuredClone(baseConfig || settings?.config || {});
    const res = await call('scan_import', {});
    const draft = poolDirty && settings?.config ? structuredClone(settings.config) : null;
    settings = { ...res, config: draft ? mergeScanDraft(res.config, before, draft) : res.config };
    baseConfig = structuredClone(res.config);
    poolDirty = Boolean(draft && JSON.stringify(settings.config) !== JSON.stringify(res.config));
    updateSave();
    renderPool();
    if (!$('settings').hidden) renderSettings();
    if (res.addedModels > 0 || res.addedRoutes > 0 || res.refreshedModels > 0) {
      const parts = [];
      if (res.addedModels > 0) parts.push(`${res.addedModels} yeni model`);
      if (res.refreshedModels > 0) parts.push(`${res.refreshedModels} model güncellendi`);
      notice(`${parts.join(' · ')} otomatik çekildi.${showErrors && res.catalogErrors?.length ? ` (${res.catalogErrors.length} bağlantı hata verdi)` : ''}`);
      if (refreshAfter) {
        await refresh();
        void refreshQuotas();
      }
    } else if (refreshAfter) {
      await refresh();
    }
    return res;
  } catch {
    return null;
  } finally {
    catalogSyncing = false;
  }
}

async function runScanImport(routeId) {
  const draft = poolDirty ? structuredClone(settings.config) : null;
  const before = baseConfig || settings?.config;
  const res = await call('scan_import', typeof routeId === 'string' ? { routeId } : {});
  settings = { ...res, config: draft ? mergeScanDraft(res.config, before, draft) : res.config };
  poolDirty = Boolean(draft);
  baseConfig = structuredClone(res.config);
  renderPool();
  if (!$('settings').hidden) renderSettings();
  await refresh();
  notice(`Tarama: ${res.discoveredCount} araç, ${res.addedModels} yeni model${res.refreshedModels ? `, ${res.refreshedModels} model güncellendi` : ''}. ${draft ? 'Kaydetmediğiniz seçimler korundu.' : 'Katalog güncellendi.'}${res.catalogErrors?.length ? ` ${res.catalogErrors.map(error => `${error.routeId}: ${error.message}`).join(' ')}` : ''}`, Boolean(res.catalogErrors?.length));
  void refreshQuotas();
}

async function addAccount(routeId) {
  const started = await call('add_account', { routeId });
  notice(`${started.message} Diğer hesabınızla giriş yapın; giriş algılanınca ${started.pending} otomatik eklenecek (10 dakika beklenir).`);
  if (accountWaits.has(routeId)) return;
  accountWaits.add(routeId);
  void (async () => {
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 4000));
        const res = await call('finish_account', { routeId });
        if (res.pending) continue;
        const draft = poolDirty ? structuredClone(settings.config) : null;
        const before = baseConfig || settings?.config;
        settings = { ...res, config: draft ? mergeScanDraft(res.config, before, draft) : res.config };
        poolDirty = Boolean(draft);
        baseConfig = structuredClone(res.config);
        renderPool();
        if (!$('settings').hidden) renderSettings();
        await refresh();
        notice(`Giriş başarılı: ${res.addedRoute} havuza eklendi.`);
        void refreshQuotas();
        return;
      }
      notice('Giriş 10 dakika içinde algılanmadı; hesap eklenmedi. Yeniden deneyebilirsiniz.', true);
    } catch (error) { notice(error.message, true); }
    finally { accountWaits.delete(routeId); }
  })();
}

async function waitForServiceVersion(target, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 700));
    try {
      const snap = await call('snapshot');
      if (snap?.version && snap.version === target) return true;
    } catch { /* Servis yeniden başlıyor; tekrar dene. */ }
  }
  return false;
}

async function triggerUpdate() {
  const res = await call('update_service');
  const details = [];
  if (res.installedVersion) details.push(`v${res.installedVersion}`);
  if (res.shortcut) details.push('masaüstü kısayolu güncellendi');
  if (res.skill) details.push('skill dağıtımı yenilendi');
  notice(`Güncelleme tamamlandı${details.length ? ` (${details.join(' · ')})` : ''}.`);
  if (res.restartScheduled) {
    notice('Yeni sürüm kuruldu; servis yeniden başlatılıyor…');
    const ready = await waitForServiceVersion(res.installedVersion);
    if (ready) {
      location.reload();
      return;
    }
    notice('Servis yeniden başlatılamadı. "Güncelle" düğmesini tekrar deneyin.', true);
    return;
  }
  await refresh();
}

async function triggerSafeExit() {
  let res = await call('shutdown', { force: false });
  if (res.confirmRequired) {
    if (!window.confirm(`Şu anda ${res.activeCount} çalışan görev var. Yine de servisi kapatıp güvenli çıkış yapmak istiyor musunuz?`)) {
      notice('Güvenli çıkış iptal edildi.');
      return;
    }
    res = await call('shutdown', { force: true });
  }
  if (res.stopping) {
    serviceStopped = true;
    clearInterval(refreshIntervalId);
    clearInterval(quotaIntervalId);
    clearInterval(catalogIntervalId);
    $('connection-state').textContent = 'Güvenli kapatıldı';
    $('connection-state').dataset.connected = 'false';
    $('connection-state').title = 'Servis güvenli şekilde kapatıldı';
    notice(res.message || 'CLI Agent Pool servisi güvenli şekilde kapatıldı.');
  }
}

$('update-app')?.addEventListener('click', () => void action(triggerUpdate));
$('settings-update')?.addEventListener('click', () => void action(triggerUpdate));
$('safe-exit')?.addEventListener('click', () => void action(triggerSafeExit));
$('settings-shutdown')?.addEventListener('click', () => void action(triggerSafeExit));

async function refresh() {
  if (refreshing || serviceStopped) return;
  refreshing = true;
  try {
    const wasOffline = $('connection-state').textContent === 'Bağlantı yok';
    snapshot = await call('snapshot');
    $('app-version').textContent = `v${snapshot.version || 'bilinmiyor'}`;
    if (!settings || (!poolDirty && settings.revision !== snapshot.revision)) {
      const firstLoad = !settings;
      settings = await call('settings');
      if (firstLoad) {
        try {
          const draft = JSON.parse(localStorage.getItem('pool-draft') || 'null');
          if (draft?.base?.routes && draft?.config?.routes) {
            settings.config = mergeScanDraft(settings.config, draft.base, draft.config);
            dirty();
            notice('Kaydedilmemiş değişiklikler geri yüklendi. Kaydedebilir veya vazgeçebilirsiniz.');
          }
        } catch { /* Invalid or unavailable browser drafts do not block the saved configuration. */ }
      }
      renderPool();
      if (!$('settings').hidden) renderSettings();
    }
    $('connection-state').textContent = 'Bağlı';
    $('connection-state').dataset.connected = 'true';
    $('connection-state').title = 'Bağlı';

    renderCalls();
    updateCardActivity();
    if (selectedTask && $('detail').open) await openTask(selectedTask, false);
    if (wasOffline) notice('Bağlantı yeniden kuruldu.');
  } catch (error) {
    if (!serviceStopped) {
      $('connection-state').textContent = 'Bağlantı yok';
      $('connection-state').dataset.connected = 'false';
      $('connection-state').title = 'Bağlantı yok';
      notice(error.message, true);
    }
  } finally { refreshing = false; }
}

function settingField(label, value, update, choices, markDirty = true) {
  const wrapper = element('label', null, 'setting-field');
  wrapper.append(element('span', label));
  const input = choices ? document.createElement('select') : document.createElement('input');
  if (choices) {
    input.replaceChildren(...choices.map(choice => new Option(Array.isArray(choice) ? choice[1] : effortLabel(choice), Array.isArray(choice) ? choice[0] : choice)));
  } else input.maxLength = 100;
  input.value = value;
  input.addEventListener('change', () => {
    update(input.value);
    if (markDirty) dirty();
  });
  wrapper.append(input);
  return wrapper;
}

function renderSettingsSubscriptionPane(route, sub, email, issue) {
  const pane = element('div', null, 'settings-sub-pane');

  // Login / Logout / Session Bar per subscription
  const sessionBar = element('div', null, 'subscription-session-bar');
  const sessionInfo = element('div', null, 'subscription-session-info');
  sessionInfo.append(
    element('strong', adapterLabels[route.adapter] || route.adapter),
    element('span', email || sub.subscriptionLabel, email ? 'model-email-badge' : 'badge subtle'),
    element('span', billingLabels[route.billing] || route.billing, 'badge subtle'),
    element(
      'span',
      issue.isDisabled ? 'Kapalı' : issue.isError ? issue.badge : issue.isUnknown ? issue.badge : 'Etkin',
      `badge ${issue.isDisabled ? 'subtle' : issue.isError ? 'error' : issue.isUnknown ? 'warn' : 'ok'}`,
    ),
  );

  const sessionActions = element('div', null, 'actions subscription-session-actions');
  const locked = !activeBillings.has(route.billing);
  const enabledToggle = makeSwitch({
    checked: route.enabled,
    disabled: locked,
    onChange: async value => {
      route.enabled = value;
      dirty();
      // Anahtar anında kaydedilir: bağlantı etkinleşince aracı ve modelleri ana sayfada görünür.
      settings = await call('save', settings);
      poolDirty = false;
      baseConfig = structuredClone(settings.config);
      updateSave();
      renderSettings();
      renderPool();
      await refresh();
      notice(`${adapterLabels[route.adapter] || route.adapter} bağlantısı ${value ? 'etkinleştirildi' : 'kapatıldı'}.`);
    },
  });
  enabledToggle.wrap.title = locked
    ? 'Ödeme / plan türü doğrulanmadan bağlantı etkinleştirilemez.'
    : 'Bağlantıyı etkinleştirir veya kapatır; değişiklik anında kaydedilir.';
  sessionActions.append(enabledToggle.wrap);

  if (!route.api && !['custom', 'lmstudio', 'ollama'].includes(route.adapter)) {
    const q = snapshot?.quotas?.[route.id];
    const hasSession = Boolean(q && (q.status === 'available' || q.status === 'rate_limited' || q.windows?.length > 0)) || Boolean(email && q?.status !== 'auth_required');
    sessionActions.append(button(hasSession ? 'Hesabı değiştir / Yeniden giriş' : 'Giriş yap', async () => {
      const result = await call('login', { routeId: route.id });
      notice(result.message);
    }));
  }

  sessionActions.append(button('Kotayı kontrol et', async () => {
    const q = await call('quota', { routeId: route.id, force: true });
    await refresh();
    renderSettings();
    showDetail(q);
  }));

  if (route.runtime === 'wsl' || (route.adapter === 'agy' && route.profile)) {
    sessionActions.append(button('İzinleri eşitle', async () => {
      const result = await call('sync_permissions', { routeId: route.id });
      const synced = result.synced[route.id] || { projects: 0, grants: 0, trusted: 0 };
      notice(`${sub.subscriptionLabel}: ${synced.projects} proje, ${synced.grants} izin ve ${synced.trusted} güvenilir klasör profil ile eşitlendi.`);
    }));
  }

  const removeRouteBtn = button('Aboneliği kaldır', async () => {
    const draft = poolDirty ? structuredClone(settings.config) : null;
    const before = baseConfig || settings?.config;
    const res = await call('delete_route', { routeId: route.id });
    if (draft) draft.routes = draft.routes.filter(r => r.id !== route.id);
    if (before) before.routes = before.routes.filter(r => r.id !== route.id);
    selectedSettingsRoute.delete(route.adapter);
    settings = { ...res, config: draft ? mergeScanDraft(res.config, before, draft) : res.config };
    baseConfig = structuredClone(res.config);
    poolDirty = Boolean(draft && JSON.stringify(settings.config) !== JSON.stringify(res.config));
    updateSave();
    renderSettings();
    renderPool();
    await refresh();
    notice(`${sub.subscriptionLabel} (${adapterLabels[route.adapter] || route.adapter}) kaldırıldı.`);
  });
  removeRouteBtn.className = 'danger';
  sessionActions.append(removeRouteBtn);

  sessionBar.append(sessionInfo, sessionActions);
  pane.append(sessionBar);

  const authNote = loginNotice(route);
  if (authNote.children.length) pane.append(authNote);

  const grid = element('div', null, 'settings-grid');
  grid.append(
    settingField('Ödeme / plan türü', route.billing, value => {
      route.billing = value;
      enabled.disabled = !activeBillings.has(value);
      enabled.dataset.locked = String(!activeBillings.has(value));
    }, Object.entries(billingLabels).map(([k, v]) => [k, v])),
    settingField('Dosya araçları', route.toolPolicy || 'native', value => { route.toolPolicy = value; }, [['native', 'Native CLI yetenekleri · istek text/read/write seçer'], ['configured', 'Yapılandırılmış model kapsamıyla sınırla']]),
    settingField('Öncelik (küçük değer önce)', route.priority, value => { route.priority = Number(value); }),
    settingField('Seçim için asgari kalan kota (%)', route.minRemainingPercent, value => { route.minRemainingPercent = Number(value); }),
  );
  pane.append(grid);

  if (route.billing === 'paid_api') {
    const autoLabel = element('label', null, 'route-header');
    const autoCheck = document.createElement('input');
    autoCheck.type = 'checkbox';
    autoCheck.checked = route.autoSelect ?? route.billing !== 'paid_api';
    autoCheck.addEventListener('change', () => { route.autoSelect = autoCheck.checked; });
    autoLabel.append(autoCheck, element('span', 'Bu ücretli API için kategori isteklerinde kullanıma izin ver'));
    pane.append(autoLabel);
  }

  if (route.api) {
    pane.append(settingField('API adresi', route.api.baseUrl, value => { route.api.baseUrl = value; }));
    const secretRef = route.api.secretRef || route.id;
    route.api.secretRef = secretRef;
    const hasKey = settings.secretStates?.[route.id];
    const keyRow = element('div', null, 'actions');
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.setAttribute('aria-label', `${sub.subscriptionLabel} API anahtarı`);
    keyInput.placeholder = hasKey ? 'Kayıtlı anahtar var (değiştirmek için yeni anahtar yazın)' : 'API anahtarı girin';
    const keyBtn = button('Anahtarı kaydet', async () => {
      if (!keyInput.value.trim()) throw new Error('Kaydedilecek API anahtarını girin.');
      await call('secret', { secretRef, secret: keyInput.value });
      keyInput.value = '';
      settings.secretStates ||= {};
      settings.secretStates[route.id] = true;
      renderSettings();
      await refresh();
      notice(`${sub.subscriptionLabel} için API anahtarı yerel kasaya kaydedildi.`);
    });
    keyRow.append(keyInput, keyBtn);
    pane.append(keyRow);
  } else if (route.adapter !== 'codex') {
    const trustedLabel = element('label', null, 'route-header');
    const trusted = document.createElement('input');
    trusted.type = 'checkbox';
    trusted.checked = route.trustedSettings;
    trusted.addEventListener('change', () => { route.trustedSettings = trusted.checked; });
    trustedLabel.append(trusted, element('span', `CLI yerel ayarlarını inceledim (Giriş komutu: ${loginCommandsLabel(route.adapter)})`));
    pane.append(trustedLabel);
  }

  // Hesaba bağlı modeller paneli + Aile & Arama filtreleri + Kalıcı settings dışlama onay kutusu
  const modelsPanel = element('div', null, 'route-models-panel');
  const filters = settings.config.modelFilters || [];
  const activeCount = route.models.filter(m => !modelFiltered(filters, route.id, m.id)).length;
  const filteredCount = route.models.length - activeCount;

  const panelHeader = element('div', null, 'route-models-header');
  panelHeader.append(element('strong', `Hesaba bağlı modeller (${route.models.length} model · ${activeCount} aktif${filteredCount ? ` · ${filteredCount} filtreli` : ''})`));

  const modelsToolbar = element('div', null, 'route-models-toolbar actions');
  if (!route.api && route.adapter !== 'custom') {
    modelsToolbar.append(button('Model sürümlerini yenile', async () => { await refreshCatalog(route.id); }));
  }
  if (filteredCount > 0) {
    modelsToolbar.append(button(`Tümünü sisteme dahil et (${filteredCount})`, async () => {
      settings.config.modelFilters = unhideModels(
        settings.config.modelFilters || [],
        settings.config.routes,
        route.models.map(m => ({ routeId: route.id, modelId: m.id })),
      );
      await savePreference('modelFilters');
      notice(`${sub.subscriptionLabel}: tüm modeller sisteme dahil edildi.`);
    }));
  }
  if (activeCount > 0) {
    modelsToolbar.append(button(`Tümünü filtrele (${activeCount})`, async () => {
      let next = settings.config.modelFilters || [];
      for (const m of route.models) {
        next = setRouteModelSettingsFilter(next, route.id, m.id, true, settings.config.routes);
      }
      settings.config.modelFilters = next;
      await savePreference('modelFilters');
      notice(`${sub.subscriptionLabel}: ${activeCount} model katalog ve havuzlardan gizlendi.`);
    }));
  }

  const familyBar = element('div', null, 'hierarchy-pills route-models-families');
  const modelsList = element('div', null, 'route-models-list');

  const renderRouteModelRows = () => {
    const q = (routeModelsSearch.get(route.id) || '').trim().toLocaleLowerCase('tr');
    const searchedModels = q
      ? route.models.filter(m => `${m.id} ${m.alias || ''} ${modelFamily(m.id)} ${familyLabel(modelFamily(m.id))}`.toLocaleLowerCase('tr').includes(q))
      : route.models;

    const byFam = new Map();
    for (const m of searchedModels) {
      const fam = modelFamily(m.id);
      byFam.set(fam, (byFam.get(fam) || 0) + 1);
    }
    const famList = [...byFam.entries()]
      .map(([id, count]) => ({ id, label: familyLabel(id), count }))
      .sort((a, b) => a.label.localeCompare(b.label, 'tr'));
    let activeFamily = routeModelsFamily.get(route.id) || '__all__';
    if (activeFamily !== '__all__' && !famList.some(f => f.id === activeFamily)) {
      activeFamily = '__all__';
      routeModelsFamily.set(route.id, activeFamily);
    }

    if (famList.length > 1) {
      const famPills = [{ id: '__all__', label: 'Tüm aileler', count: searchedModels.length }, ...famList];
      familyBar.hidden = false;
      familyBar.replaceChildren(...famPills.map(f => {
        const btn = element('button', `${f.label} (${f.count})`);
        btn.type = 'button';
        const isSel = f.id === activeFamily;
        btn.classList.toggle('selected', isSel);
        btn.setAttribute('aria-pressed', String(isSel));
        btn.addEventListener('click', () => {
          routeModelsFamily.set(route.id, f.id);
          renderRouteModelRows();
        });
        return btn;
      }));
    } else {
      familyBar.hidden = true;
      familyBar.replaceChildren();
    }

    const familyFiltered = activeFamily === '__all__'
      ? searchedModels
      : searchedModels.filter(m => modelFamily(m.id) === activeFamily);
    const sortedModels = sortModels(familyFiltered.map(model => ({ route, model })), 'family', false, sortContext(''));

    if (!sortedModels.length) {
      modelsList.replaceChildren(element(
        'p',
        route.models.length ? 'Arama veya aile filtresine uyan model yok.' : 'Bu abonelikte henüz çekilmiş model yok. "Model sürümlerini yenile" düğmesine basın.',
        'empty',
      ));
      return;
    }

    modelsList.replaceChildren(...sortedModels.map(({ model }) => {
      const currentFilters = settings.config.modelFilters || [];
      const excluded = modelFiltered(currentFilters, route.id, model.id);
      const row = element('label', null, `route-model-row${excluded ? ' is-filtered' : ''}`);
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'route-model-exclude';
      check.checked = excluded;
      check.setAttribute('aria-label', `${model.id} modelini gizle / katalog ve havuz dışı bırak`);
      check.addEventListener('change', () => void action(async () => {
        settings.config.modelFilters = setRouteModelSettingsFilter(
          settings.config.modelFilters || [],
          route.id,
          model.id,
          check.checked,
          settings.config.routes,
        );
        await savePreference('modelFilters');
        notice(`${model.id} (${sub.subscriptionLabel}) ${check.checked ? 'sistemden gizlendi (katalog/havuz dışı)' : 'sisteme dahil edildi'}.`);
      }));

      const textWrap = element('div', null, 'route-model-info');
      const titleLine = element('div', null, 'route-model-title');
      titleLine.append(element('strong', model.id));
      if (model.alias && model.alias !== model.id) titleLine.append(element('small', model.alias));
      textWrap.append(titleLine);

      const meta = element('div', null, 'route-model-meta');
      meta.append(element('span', familyLabel(modelFamily(model.id)), 'badge subtle'));
      if (model.efforts?.length) meta.append(element('span', model.efforts.join(', '), 'badge subtle'));
      const poolsList = memberships(model).map(m => groupLabel(m.group));
      if (poolsList.length) meta.append(element('span', `Havuz: ${poolsList.join(', ')}`, 'badge subtle'));
      meta.append(element('span', excluded ? 'Filtreli (Katalog/Havuz dışı)' : 'Sistemde aktif', `badge ${excluded ? 'warn' : 'ok'}`));

      row.append(check, textWrap, meta);
      return row;
    }));
  };

  if (route.models.length > 3) {
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'route-models-search';
    searchInput.value = routeModelsSearch.get(route.id) || '';
    searchInput.placeholder = 'Modellerde ara…';
    searchInput.setAttribute('aria-label', `${sub.subscriptionLabel} modellerinde ara`);
    searchInput.addEventListener('input', () => {
      routeModelsSearch.set(route.id, searchInput.value);
      renderRouteModelRows();
    });
    modelsToolbar.append(searchInput);
  }
  renderRouteModelRows();

  const addModelRow = element('div', null, 'actions');
  const newModelInput = document.createElement('input');
  newModelInput.setAttribute('aria-label', `${sub.subscriptionLabel} için yeni model kimliği`);
  newModelInput.placeholder = 'Bu aboneliğe manuel yeni model kimliği ekle';
  const addModelBtn = button('Model ekle', async () => {
    const id = newModelInput.value.trim();
    if (!id) throw new Error('Model kimliği girin.');
    if (route.models.some(m => m.id === id)) throw new Error('Bu model zaten ekli.');
    const kinds = ['mmx', 'ollama', 'lmstudio', 'omniroute'].includes(route.adapter) ? ['text'] : ['text', 'read', 'write'];
    route.models.push({ id, alias: id, group: route.billing === 'free' ? 'free' : 'unassigned', enabled: true, efforts: [], kinds });
    newModelInput.value = '';
    await saveModel(route.id, id);
  });
  addModelRow.append(newModelInput, addModelBtn);

  const modelsBody = element('div', null, 'route-models-body');
  modelsBody.append(panelHeader, modelsToolbar, familyBar, modelsList, addModelRow);
  modelsPanel.append(modelsBody);
  pane.append(modelsPanel);

  return pane;
}

// Bir liste yeniden kurulurken sayfa kaydırma konumu, odak ve açık paneller korunur;
// kullanıcı yerini kaybetmez.
function withStableView(render) {
  const scrollY = window.scrollY;
  const active = document.activeElement;
  const activeId = active?.id || '';
  const activeLabel = active?.getAttribute?.('aria-label') || '';
  const openDetails = new Set();
  for (const node of document.querySelectorAll('details')) {
    if (node.open) openDetails.add(`${node.querySelector('summary')?.textContent?.trim() || ''}`);
  }
  try {
    render();
  } finally {
    window.scrollTo({ top: scrollY });
    if (activeId) {
      $(activeId)?.focus?.({ preventScroll: true });
    } else if (activeLabel) {
      const match = [...document.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === activeLabel);
      match?.focus?.({ preventScroll: true });
    }
    for (const node of document.querySelectorAll('details')) {
      const key = node.querySelector('summary')?.textContent?.trim() || '';
      if (openDetails.has(key)) node.open = true;
    }
  }
}

// Ayarlar sayfasının görüntülenen verisinin imzası: değişmediyse liste yeniden kurulmaz.
let settingsRenderSignature = '';
function settingsSignature() {
  const uiSig = [
    selectedSettingsTool,
    [...selectedSettingsRoute.entries()].map(([key, value]) => `${key}=${value}`).join(','),
    $('routes-search')?.value || '',
    $('routes-filter')?.value || '',
  ].join('|');
  return settingsViewSignature(settings?.config, snapshot?.quotas || {}, uiSig);
}

function renderSettings(force = false) {
  if (!settings || !snapshot) return;
  const signature = settingsSignature();
  if (!force && signature === settingsRenderSignature) return;
  settingsRenderSignature = signature;
  withStableView(() => renderSettingsBody());
}

function renderSettingsBody() {
  if (!settings || !snapshot) return;
  fillOriginPlaceholders();
  const previousAdapter = $('new-adapter').value;
  const adapters = snapshot.installed.filter(cli => cli.status === 'installed');
  $('new-adapter').replaceChildren(new Option('CLI seçin', ''), ...adapters.map(cli => new Option(`${cli.label || cli.adapter} (${cli.discoveredModels?.length || 0} model)`, cli.adapter)));
  if (adapters.some(cli => cli.adapter === previousAdapter)) $('new-adapter').value = previousAdapter;

  const routeSearch = ($('routes-search')?.value || '').trim().toLocaleLowerCase('tr');
  const routeFilter = $('routes-filter')?.value || 'all';

  const matchingRoutes = settings.config.routes.filter(route => {
    const email = routeEmail(route.id);
    const issue = modelIssueInfo(route, { id: '' }, snapshot?.quotas?.[route.id], quotaErrors[route.id]);
    if (routeFilter === 'enabled' && !route.enabled) return false;
    if (routeFilter === 'disabled' && route.enabled) return false;
    if (routeFilter === 'issues' && !issue.isError && !issue.isUnknown) return false;
    if (!routeSearch) return true;
    const hay = `${route.id} ${route.adapter} ${adapterLabels[route.adapter] || ''} ${email} ${route.profile || ''} ${route.api?.baseUrl || ''}`.toLocaleLowerCase('tr');
    return hay.includes(routeSearch);
  });

  if (!settings.config.routes.length) {
    $('settings-routes').replaceChildren(element('p', 'Henüz bağlantı yok. Üstteki "Modelleri tara ve aktar" düğmesine basın veya aşağıdan ekleyin.', 'empty'));
    return;
  }
  if (!matchingRoutes.length) {
    $('settings-routes').replaceChildren(element('p', 'Arama veya filtreye uyan bağlantı yok.', 'empty'));
    return;
  }

  const toolGroups = toolGroupsForRoutes(matchingRoutes, emailsMap(), adapterLabels);
  if (!toolGroups.some(g => g.adapter === selectedSettingsTool)) {
    selectedSettingsTool = toolGroups[0].adapter;
  }

  // Level 1: Alphabetical Tool Tab Bar
  const toolsNav = element('div', null, 'settings-tools-nav');
  for (const group of toolGroups) {
    const hasError = group.routes.some(sub => {
      const iss = modelIssueInfo(sub.route, { id: '' }, snapshot?.quotas?.[sub.id], quotaErrors[sub.id]);
      return iss.isError;
    });
    const enabledCount = group.routes.filter(sub => sub.enabled).length;
    const tab = element('button', null, `settings-tool-tab${group.adapter === selectedSettingsTool ? ' selected' : ''}${hasError ? ' has-issue' : ''}`);
    tab.type = 'button';
    tab.setAttribute('aria-pressed', String(group.adapter === selectedSettingsTool));
    tab.append(
      element('strong', group.label),
      element('span', `${enabledCount}/${group.routes.length} abonelik`, 'badge subtle'),
    );
    tab.addEventListener('click', () => {
      selectedSettingsTool = group.adapter;
      rememberView();
      renderSettings();
    });
    toolsNav.append(tab);
  }

  const activeTool = toolGroups.find(g => g.adapter === selectedSettingsTool) || toolGroups[0];
  let activeSubId = selectedSettingsRoute.get(activeTool.adapter);
  if (!activeTool.routes.some(sub => sub.id === activeSubId)) {
    activeSubId = activeTool.routes[0]?.id || '';
    if (activeSubId) selectedSettingsRoute.set(activeTool.adapter, activeSubId);
  }
  const activeSub = activeTool.routes.find(sub => sub.id === activeSubId) || activeTool.routes[0];

  // Tool container card
  const toolCard = element('section', null, 'settings-tool-card');
  const toolHeader = element('div', null, 'settings-tool-header');
  const toolTitle = element('div', null, 'settings-tool-title');
  toolTitle.append(
    element('h4', activeTool.label),
    element('span', `${activeTool.routes.length} abonelik / bağlantı`, 'badge subtle'),
  );
  const toolActions = element('div', null, 'actions');
  const baseAccountRoute = settings.config.routes.find(r => r.adapter === activeTool.adapter && !r.api && !r.profile)
    || activeTool.routes.find(sub => !sub.isApi)?.route;
  if (baseAccountRoute && accountAdapters.has(activeTool.adapter)) {
    const addAccBtn = button(`+ Yeni ${activeTool.adapter === 'agy' ? 'Antigravity hesabı' : 'abonelik'} ekle`, () => addAccount(baseAccountRoute.id));
    addAccBtn.classList.add('primary');
    toolActions.append(addAccBtn);
  }
  toolHeader.append(toolTitle, toolActions);
  toolCard.append(toolHeader);

  // Level 2: Subscription Sub-tabs under the selected Tool
  const subsNav = element('div', null, 'settings-subs-nav');
  for (const sub of activeTool.routes) {
    const iss = modelIssueInfo(sub.route, { id: '' }, snapshot?.quotas?.[sub.id], quotaErrors[sub.id]);
    const isSel = sub.id === activeSub?.id;
    const subBtn = element('button', null, `settings-sub-tab${isSel ? ' selected' : ''}${iss.isError ? ' has-issue' : ''}${!sub.enabled ? ' is-disabled' : ''}`);
    subBtn.type = 'button';
    subBtn.setAttribute('aria-pressed', String(isSel));
    const statusText = iss.isDisabled ? 'Kapalı' : iss.isError ? 'Sorunlu' : iss.isUnknown ? 'Kota ?' : 'Etkin';
    const statusTone = iss.isDisabled ? 'subtle' : iss.isError ? 'error' : iss.isUnknown ? 'warn' : 'ok';
    subBtn.append(
      element('span', sub.subscriptionLabel, 'settings-sub-label'),
      element('span', statusText, `badge ${statusTone}`),
    );
    subBtn.addEventListener('click', () => {
      selectedSettingsRoute.set(activeTool.adapter, sub.id);
      rememberView();
      renderSettings();
    });
    subsNav.append(subBtn);
  }
  toolCard.append(subsNav);

  // Level 3: Selected Subscription Details & Models Checklist
  if (activeSub) {
    const email = activeSub.email || routeEmail(activeSub.id);
    const issue = modelIssueInfo(activeSub.route, { id: '' }, snapshot?.quotas?.[activeSub.id], quotaErrors[activeSub.id]);
    toolCard.append(renderSettingsSubscriptionPane(activeSub.route, activeSub, email, issue));
  }

  $('settings-routes').replaceChildren(toolsNav, toolCard);
  if (busy) $('settings-routes').querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = true; });
}

$('routes-search')?.addEventListener('input', () => renderSettings());
$('routes-filter')?.addEventListener('change', () => renderSettings());

function loginCommandsLabel(adapter) {
  const found = snapshot?.installed?.find(cli => cli.adapter === adapter);
  return found?.loginCommand || adapter;
}

$('new-adapter').addEventListener('change', () => {
  const adapter = $('new-adapter').value;
  const cli = snapshot?.installed?.find(item => item.adapter === adapter);
  if (cli?.defaultBilling) $('new-billing').value = cli.defaultBilling;
});

$('refresh').addEventListener('click', () => void action(async () => { await autoSyncCatalogs({ showErrors: true, refreshAfter: false, ignoreBusy: true }); await refresh(); await refreshQuotas(); }));
$('scan-import').addEventListener('click', () => void action(runScanImport));
$('sync-all-permissions')?.addEventListener('click', () => void action(async () => {
  const result = await call('sync_permissions', {});
  const ids = Object.keys(result.synced || {});
  notice(ids.length ? `${ids.length} Antigravity profilinin proje ve izin ayarları eşitlendi (${ids.join(', ')}).` : 'Eşitlenecek ek Antigravity profili bulunamadı.');
}));
$('close-detail').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => {
  $('detail').hidden = true;
  selectedTask = null;
  selectedTaskStamp = '';
  $('calls-tab').focus();
});
$('open-settings').addEventListener('click', () => switchPage('settings'));

function makeSwitch({ checked = false, disabled = false, onChange, onLabel = 'Etkin', offLabel = 'Kapalı' } = {}) {
  const wrap = element('label', null, 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-checked', String(checked));
  const state = element('span', checked ? onLabel : offLabel, 'switch-state');
  const track = element('span', null, 'switch-track');
  track.append(element('span', null, 'switch-thumb'));
  input.addEventListener('change', () => {
    state.textContent = input.checked ? onLabel : offLabel;
    input.setAttribute('aria-checked', String(input.checked));
    onChange?.(input.checked);
  });
  wrap.append(input, track, state);
  return { wrap, input };
}

async function saveSettings() {
  settings = await call('save', settings);
  poolDirty = false;
  renderSettings();
  renderPool();
  await refresh();
  notice('Kaydedildi.');
}

async function saveModel(routeId, modelId, enableRoute = false, message = 'Model değişikliği kaydedildi.') {
  dirty();
  const before = structuredClone(baseConfig), draft = structuredClone(settings.config);
  const saved = await call('save', { ...settings, config: modelSaveConfig(before, draft, routeId, modelId, enableRoute) });
  settings = { ...saved, config: mergeScanDraft(saved.config, before, draft) };
  poolDirty = JSON.stringify(settings.config) !== JSON.stringify(saved.config);
  updateSave();
  renderPool();
  if (!$('settings').hidden) renderSettings();
  await refresh();
  notice(message);
}

async function saveModelsBatch(targets, enableRoutes = false, message = 'Seçilen modeller kaydedildi.') {
  if (!targets.length) return;
  dirty();
  const before = structuredClone(baseConfig), draft = structuredClone(settings.config);
  const saved = await call('save', { ...settings, config: batchModelSaveConfig(before, draft, targets, enableRoutes) });
  settings = { ...saved, config: mergeScanDraft(saved.config, before, draft) };
  poolDirty = JSON.stringify(settings.config) !== JSON.stringify(saved.config);
  updateSave();
  renderPool();
  if (!$('settings').hidden) renderSettings();
  await refresh();
  notice(message);
}

$('save-pool').addEventListener('click', () => void action(saveSettings));
$('settings').addEventListener('change', event => {
  if (['theme', 'routes-search', 'routes-filter'].includes(event.target.id)) return;
  if (event.target.classList?.contains('route-models-search') || event.target.classList?.contains('route-model-exclude')) return;
  dirty();
});

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
  const kinds = ['mmx', 'ollama', 'lmstudio', 'omniroute'].includes(adapter) ? ['text'] : ['text', 'read', 'write'];
  const initialModels = modelId
    ? [{ id: modelId, alias: modelId, group: billing === 'free' ? 'free' : 'unassigned', enabled: true, efforts: [], kinds }]
    : (cli.discoveredModels || []).map(({ free, ...m }) => ({ ...m, ...(free === true ? { billing: 'free' } : {}) }));
  const route = { id, adapter, executable: cli.executable, enabled: false, billing, trustedSettings: true, priority: 100, models: initialModels };
  settings.config.routes.push(route);
  settings = await call('save', settings);
  if (!modelId && ['codex', 'opencode', 'mimo'].includes(adapter)) {
    try {
      const catalog = await call('catalog', { routeId: id });
      settings.config.routes.find(connection => connection.id === id).models = catalog.models.map(model => ({
        id: model.id, alias: model.name, group: model.free ? 'free' : 'unassigned', enabled: true, efforts: model.efforts, ...(model.free ? { billing: 'free' } : {}), kinds,
      }));
      settings = await call('save', settings);
    } catch {}
  }
  $('new-model').value = '';
  $('subscription-confirmed').checked = false;
  renderSettings();
  renderPool();
  await refresh();
  notice(`${id} bağlantısı (${initialModels.length} model) eklendi.`);
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
    priority: billing === 'paid_api' ? 200 : 100,
    api: { protocol, baseUrl, secretRef: id },
    models: modelNames.map(m => ({ id: m, alias: m, group: billing === 'free' ? 'free' : 'api', enabled: true, efforts: [], kinds: ['text', 'read', 'write'] })),
  };
  settings.config.routes.push(route);
  settings = await call('save', { ...settings, secrets: apiKey ? { [id]: apiKey } : {} });
  $('api-id').value = '';
  $('api-base-url').value = '';
  $('api-key').value = '';
  $('api-models').value = '';
  renderSettings();
  renderPool();
  await refresh();
  notice(`${id} API bağlantısı eklendi ve etkinleştirildi.`);
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
    enabled: false, billing, trustedSettings: true, priority: 100,
    models: modelNames.map(m => ({ id: m, alias: m, group: 'custom', enabled: true, efforts: [], kinds: ['text', 'read', 'write'] })),
  };
  settings.config.routes.push(route);
  settings = await call('save', settings);
  $('custom-cli-id').value = '';
  $('custom-cli-exe').value = '';
  $('custom-cli-args').value = '';
  $('custom-cli-models').value = '';
  renderSettings();
  renderPool();
  await refresh();
  notice(`${id} özel CLI bağlantısı eklendi.`);
}));

function switchPage(page) {
  $('pool-panel').hidden = page !== 'pool';
  $('calls-panel').hidden = page !== 'calls';
  $('settings').hidden = page !== 'settings';
  if (page === 'pool') renderPool();
  if (page === 'calls') renderCalls();
  if (page === 'settings' && settings) renderSettings();
  $('detail').close();
  $('detail').hidden = true;
  selectedTask = null;
  selectedTaskStamp = '';
  for (const [id, target] of [['pool-tab', 'pool'], ['calls-tab', 'calls'], ['open-settings', 'settings']]) {
    if (page === target) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
}

document.querySelector('.skip').addEventListener('click', () => { switchPage('pool'); $('toggle-pool').focus(); });
$('pool-tab').addEventListener('click', () => switchPage('pool'));
$('calls-tab').addEventListener('click', () => switchPage('calls'));
$('pool-search').addEventListener('input', () => { $('pool-models').scrollTop = 0; renderCatalog(); });
$('pool-member-search')?.addEventListener('input', () => { $('pool-members').scrollTop = 0; renderPool(); });
$('hidden-search')?.addEventListener('input', () => { $('hidden-models').scrollTop = 0; renderHidden(); });
$('discard-settings').addEventListener('click', () => void action(async () => {
  settings = await call('settings');
  poolDirty = false;
  baseConfig = structuredClone(settings.config);
  renderSettings();
  renderPool();
  updateSave();
}));

$('toggle-quotas').addEventListener('click', () => {
  const details = [...document.querySelectorAll('.quota-details')];
  // One control for every quota block: open the detail bodies and show the
  // flat quota lines, or collapse both.
  quotasOpen = quotaToggleTarget(details);
  quotaStates.clear();
  details.forEach(node => { node.open = quotasOpen; });
  updateQuotaToggle();
  rememberView();
});

function updateQuotaToggle() {
  const details = [...document.querySelectorAll('.quota-details')];
  const button = $('toggle-quotas');
  document.body.classList.toggle('quota-collapsed', !quotasOpen);
  const state = quotaToggleState(details);
  button.textContent = state.label;
  button.setAttribute('aria-pressed', String(state.pressed));
  button.disabled = state.disabled;
  button.title = state.title;
}

const quotaLevel = remaining => remaining >= 50 ? 'ok' : remaining >= 20 ? 'mid' : 'low';

function quotaBody(q, modelId = '', error) {
  const cell = element('div', null, 'quota-body');
  const windows = quotaWindows(q, modelId);
  for (const window of windows) {
    const name = ({
      five_hour: '5 saat', seven_day: '7 gün', '5h': '5 saat', '7d': '7 gün',
      weekly: 'Haftalık', monthly: 'Aylık', opus: 'Opus haftalık', primary: 'Kısa dönem', secondary: 'Haftalık',
    })[window.name] || (window.windowMinutes ? window.windowMinutes >= 1440 ? `${window.windowMinutes / 1440} gün` : `${window.windowMinutes / 60} saat` : window.name);
    const line = element('div', null, 'usage-line');
    line.dataset.level = quotaLevel(window.remaining);
    const heading = element('div', null, 'quota-heading');
    heading.append(element('span', name), element('strong', `%${window.remaining.toFixed(0)} kalan`));
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = window.remaining;
    bar.setAttribute('aria-label', `${name} kalan kota`);
    line.append(heading, bar, element('small', `%${window.used.toFixed(0)} kullanıldı${window.resetsAt ? ` · Yenilenme: ${new Date(typeof window.resetsAt === 'number' && window.resetsAt < 1e12 ? window.resetsAt * 1000 : window.resetsAt).toLocaleString('tr-TR')}` : ''}`));
    cell.append(line);
  }
  if (q?.note) cell.append(element('small', q.note, 'quota-note'));
  if (!windows.length) {
    cell.append(element('p', error || (quotasRefreshing ? 'Kota sorgulanıyor…' : q?.status === 'auth_required' ? 'Giriş gerekli' : q?.lastRejectedAt ? 'Son Qwen CLI çağrısı kota nedeniyle reddedildi; bu geçmiş hata kalan kotayı ölçmez' : q?.status === 'rate_limited' ? 'Son CLI çağrısı kota nedeniyle reddedildi; yüzde/bakiye bilgisi mevcut değil' : q ? 'Sağlayıcı yüzde kotası bildirmiyor' : 'Kota henüz sorgulanmadı'), 'hint'));
  }
  if (windows.length) {
    cell.append(element('small', `${q.scope === 'model' ? 'Model kotası' : 'Hesap kotası'}${q.observedAt ? ` · Ölçüm: ${new Date(q.observedAt).toLocaleTimeString('tr-TR')}` : ''}${Date.now() - Date.parse(q.observedAt) >= 60000 ? ' · eski ölçüm' : ''}${error ? ' · son sorgu başarısız' : ''}`, 'quota-stamp'));
  }
  return cell;
}

function quotaCell(route, model) {
  const cell = element('div', null, 'quota-cell');
  const q = snapshot?.quotas?.[route.id];
  const windows = quotaWindows(q, model.id);
  if (!windows.length) {
    // Without a percentage window there is nothing to expand. A disclosure row
    // would only add an arrow and an empty "Bilinmiyor" pill to every card.
    const text = quotaFlatText(q, quotaErrors[route.id]);
    if (text) cell.append(element('small', text, 'quota-flat'));
    return cell;
  }
  const details = element('details', null, 'quota-details');
  const key = JSON.stringify([route.id, model.id]);
  details.dataset.quotaKey = key;
  details.dataset.level = quotaLevel(Math.min(...windows.map(window => window.remaining)));
  details.open = quotaStates.has(key) ? quotaStates.get(key) : quotasOpen;
  const summary = element('summary');
  summary.append(element('span', 'Kota'), element('strong', `%${Math.min(...windows.map(window => window.remaining)).toFixed(0)} kalan`));
  details.append(summary, quotaBody(q, model.id, quotaErrors[route.id]));
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    quotaStates.set(key, details.open);
    document.querySelectorAll('.quota-details').forEach(other => {
      if (other !== details && other.dataset.quotaKey === key) other.open = details.open;
    });
    updateQuotaToggle();
    rememberView();
  });
  cell.append(details);
  return cell;
}

function quotaFlatText(q, error = '') {
  if (error) return `Kota sorgusu başarısız: ${error}`;
  if (q?.note) return q.note;
  if (!q) return quotasRefreshing ? 'Kota sorgulanıyor…' : 'Kota henüz sorgulanmadı';
  if (q.status === 'auth_required') return 'Giriş gerekli';
  if (q.status === 'rate_limited') return 'Son çağrı kota nedeniyle reddedildi';
  if (q.status === 'available') return 'Kota yüzdesi bildirilmiyor';
  return 'Kota yüzdesi bildirilmiyor';
}

function entryMatchesQuotaFilter(route, model) {
  return quotaMatches(
    snapshot?.quotas?.[route.id],
    model.id,
    $('quota-filter').value,
    route,
    model,
    quotaErrors[route.id] || '',
  );
}

function makeHierarchyLevel(labelText, items, selectedVal, onPick, variant = 'flat') {
  const level = element('div', null, `hierarchy-level level-${variant}`);
  const head = element('div', null, 'hierarchy-level-head');
  head.append(element('span', labelText, 'hierarchy-level-title'));
  const pills = element('div', null, 'hierarchy-pills');
  for (const item of items) {
    const disabledSuffix = variant !== 'tool' && item.enabled === false ? ' (Kapalı)' : '';
    const btn = element('button', `${item.label}${disabledSuffix} (${item.count})`);
    btn.type = 'button';
    btn.title = `${item.label}${disabledSuffix}`;
    const isSelected = item.id === selectedVal;
    btn.classList.toggle('selected', isSelected);
    if (variant !== 'tool' && item.enabled === false) btn.classList.add('is-disabled');
    btn.setAttribute('aria-pressed', String(isSelected));
    btn.addEventListener('click', () => onPick(item.id));
    pills.append(btn);
  }
  level.append(head, pills);
  return level;
}

function renderHierarchyNav(container, entries, navState, onChange, extraTopRow = null) {
  if (!container) return { tool: '__all__', routeId: '__all__', family: '__all__', filtered: entries, tools: [], subscriptions: [], families: [] };
  const result = filterHierarchy(entries, navState, emailsMap(), adapterLabels, familyLabel);
  navState.tool = result.tool;
  navState.routeId = result.routeId;
  navState.family = result.family;

  const rows = [];
  if (extraTopRow && extraTopRow.items?.length) {
    rows.push(makeHierarchyLevel(extraTopRow.label, extraTopRow.items, extraTopRow.value, extraTopRow.onSelect, 'flat'));
  }
  if (entries.length) {
    rows.push(makeHierarchyLevel('Araçlar', result.tools, result.tool, toolId => {
      onChange({ tool: toolId, routeId: '__all__', family: '__all__' });
    }, 'tool'));
    if (result.subscriptions.length > 1) {
      rows.push(makeHierarchyLevel('Abonelikler', result.subscriptions, result.routeId, subId => {
        onChange({ tool: result.tool, routeId: subId, family: '__all__' });
      }, 'flat'));
    }
    if (result.families.length > 1) {
      rows.push(makeHierarchyLevel('Model aileleri', result.families, result.family, famId => {
        onChange({ tool: result.tool, routeId: result.routeId, family: famId });
      }, 'flat'));
    }
  }
  container.replaceChildren(...rows);
  return result;
}

function renderEmailHierarchyNav(container, entries, currentEmail, onSelectEmail, currentFamily, onSelectFamily, extraTopRow = null) {
  if (!container) return entries;
  const byMail = new Map();
  for (const item of entries) {
    const mail = routeEmail(item.route.id) || '__no_email__';
    byMail.set(mail, (byMail.get(mail) || 0) + 1);
  }
  const mailItems = [
    { id: '__all__', label: 'Tüm hesaplar', count: entries.length },
    ...[...byMail.entries()]
      .sort((a, b) => (a[0] === '__no_email__' ? '~~~' : a[0]).localeCompare(b[0] === '__no_email__' ? '~~~' : b[0], 'tr'))
      .map(([id, count]) => ({ id, label: id === '__no_email__' ? 'E-postasız / API' : id, count })),
  ];
  const validEmail = currentEmail && mailItems.some(m => m.id === currentEmail) ? currentEmail : '__all__';
  const emailFiltered = validEmail === '__all__'
    ? entries
    : entries.filter(item => (routeEmail(item.route.id) || '__no_email__') === validEmail);

  const subResult = filterHierarchy(emailFiltered, { tool: '__all__', routeId: '__all__', family: currentFamily }, emailsMap(), adapterLabels, familyLabel);
  const rows = [];
  if (extraTopRow && extraTopRow.items?.length) {
    rows.push(makeHierarchyLevel(extraTopRow.label, extraTopRow.items, extraTopRow.value, extraTopRow.onSelect, 'flat'));
  }
  if (entries.length) {
    rows.push(makeHierarchyLevel('Hesaplar', mailItems, validEmail, id => onSelectEmail(id), 'flat'));
    if (subResult.families.length > 1) {
      rows.push(makeHierarchyLevel('Model aileleri', subResult.families, subResult.family, famId => onSelectFamily(famId), 'flat'));
    }
  }
  container.replaceChildren(...rows);
  return subResult.filtered;
}

function searchHaystack(route, model) {
  const email = routeEmail(route.id);
  const groupText = memberships(model).map(m => groupLabel(m.group)).join(' ');
  return `${model.id} ${model.alias || ''} ${route.id} ${route.adapter} ${adapterLabels[route.adapter] || ''} ${email} ${groupText}`.toLocaleLowerCase('tr');
}

async function moveEntryOrder(entries, fromIndex, toIndex, scopeGroup, sortSelectId) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= entries.length || toIndex >= entries.length) return;
  const reordered = [...entries];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, moved);
  const targets = [];
  reordered.forEach(({ route, model }, index) => {
    const orderValue = Math.min(10000, index);
    if (scopeGroup && scopeGroup !== '__all__') {
      model.memberships = memberships(model);
      const member = model.memberships.find(item => item.group === scopeGroup);
      if (member) member.order = orderValue;
    } else {
      model.order = orderValue;
    }
    targets.push({ routeId: route.id, modelId: model.id });
  });
  const selectEl = $(sortSelectId);
  if (selectEl && selectEl.value !== 'manual') {
    selectEl.value = 'manual';
    viewPreferences[sortSelectId] = 'manual';
    rememberView();
  }
  await saveModelsBatch(targets, false, 'Özel sıralama kaydedildi.');
}

function renderPool() {
  if (!settings) return;
  withStableView(() => renderPoolBody());
}

function renderPoolBody() {
  if (!isAllGroup(selectedGroup) && !poolGroups().includes(selectedGroup)) {
    selectedGroup = poolGroups()[0] || '__all__';
  }
  renderCategoryEditor();
  updateSave();

  const routes = activeRoutesForDisplay();
  const billingFilter = $('member-billing-filter')?.value || 'all';
  const baseMemberPool = routes.flatMap(route =>
    route.models
      .filter(model =>
        !modelFiltered(settings.config.modelFilters, route.id, model.id)
        && memberships(model).length > 0
        && billingMatches(route, model, billingFilter)
        && entryMatchesQuotaFilter(route, model),
      )
      .map(model => ({ route, model })),
  );

  // Render summary cards: UI-only "Tümünü Göster" (__all__) + each pool category
  const allCard = element('button', null, 'group-card group-__all__');
  allCard.type = 'button';
  allCard.title = 'Dış havuzlara açık değil; tüm havuz kategorilerindeki modellerinizi tek ekranda görmenizi sağlar.';
  allCard.setAttribute('aria-pressed', String(isAllGroup(selectedGroup)));
  allCard.append(element('strong', groupLabels.__all__), element('span', `${baseMemberPool.length} model · Yalnızca UI`));
  allCard.addEventListener('click', () => {
    selectedGroup = '__all__';
    selectedPoolSubgroup = '';
    selectedPoolItems.clear();
    rememberView();
    renderPool();
  });

  const groupCards = poolGroups().map(group => {
    const count = baseMemberPool.filter(({ model }) => memberships(model).some(member => member.group === group)).length;
    const card = element('button', null, `group-card group-${group}`);
    card.type = 'button';
    card.setAttribute('aria-pressed', String(selectedGroup === group));
    card.append(element('strong', groupLabel(group)), element('span', `${count} model`));
    card.addEventListener('click', () => {
      selectedGroup = group;
      selectedPoolSubgroup = '';
      selectedPoolItems.clear();
      rememberView();
      renderPool();
    });
    return card;
  });
  $('group-summary').replaceChildren(allCard, ...groupCards);

  $('members-heading').textContent = isAllGroup(selectedGroup) ? 'Havuzdaki tüm modeller' : `${groupLabel(selectedGroup)} üyeleri`;
  const allHiddenCount = settings.config.routes.reduce(
    (sum, r) => sum + r.models.filter(m => modelFiltered(settings.config.modelFilters, r.id, m.id) && hiddenReasonCategory(r, m) !== 'settings').length,
    0,
  );
  $('filter-count').textContent = allHiddenCount;

  const memberScroll = $('pool-members').scrollLeft, memberTop = $('pool-members').scrollTop;
  const search = ($('pool-member-search')?.value || '').trim().toLocaleLowerCase('tr');
  const groupFiltered = baseMemberPool.filter(({ model }) =>
    isAllGroup(selectedGroup) ? memberships(model).length > 0 : memberships(model).some(m => m.group === selectedGroup),
  );
  const searched = search
    ? groupFiltered.filter(({ route, model }) => searchHaystack(route, model).includes(search))
    : groupFiltered;

  const memberView = $('member-view').value;
  const poolNavEl = $('pool-hierarchy-nav') || $('pool-sub-nav');
  let subFiltered = searched;
  if (memberView === 'all') {
    poolNavEl?.replaceChildren();
  } else if (memberView === 'email') {
    subFiltered = renderEmailHierarchyNav(
      poolNavEl,
      searched,
      selectedPoolSubgroup || '__all__',
      id => {
        selectedPoolSubgroup = id;
        poolNav.family = '__all__';
        selectedPoolItems.clear();
        rememberView();
        renderPool();
      },
      poolNav.family,
      famId => {
        poolNav.family = famId;
        selectedPoolItems.clear();
        rememberView();
        renderPool();
      },
    );
  } else {
    subFiltered = renderHierarchyNav(poolNavEl, searched, poolNav, next => {
      poolNav = next;
      selectedPoolItems.clear();
      rememberView();
      renderPool();
    }).filtered;
  }

  const memberSort = $('member-sort')?.value || 'az';
  const sorted = sortModels(subFiltered, memberSort, false, sortContext(selectedGroup));
  if ($('pool-member-count')) $('pool-member-count').textContent = `${sorted.length} model`;

  const visibleMemberKeys = new Set();
  const rows = sorted.map((entry, idx) => {
    const { route, model } = entry;
    const member = isAllGroup(selectedGroup)
      ? { group: '__all__', memberships: memberships(model) }
      : memberships(model).find(item => item.group === selectedGroup);
    visibleMemberKeys.add(JSON.stringify([route.id, model.id]));
    return modelCard(route, model, member, {
      reorderList: sorted,
      index: idx,
      scopeGroup: selectedGroup,
      sortSelectId: 'member-sort',
      boardKey: 'pool',
    });
  });

  for (const key of [...selectedPoolItems]) {
    if (!visibleMemberKeys.has(key)) selectedPoolItems.delete(key);
  }
  renderPoolBatchBar([...visibleMemberKeys].map(key => JSON.parse(key)));
  $('pool-members').replaceChildren(
    ...(rows.length ? rows : [element('p', 'Bu görünümde model yok. Kota/ödeme filtresini kontrol edin veya aşağıdaki katalogdan model ekleyin.', 'empty')]),
  );
  $('pool-members').scrollLeft = memberScroll;
  $('pool-members').scrollTop = memberTop;
  renderCatalog();
  renderHidden();
}

function renderPoolBatchBar(visibleItems) {
  const bar = $('pool-batch-bar');
  if (!bar) return;
  if (!visibleItems.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  const selectedCount = selectedPoolItems.size;
  const info = element('span', selectedCount ? `${selectedCount} model seçildi` : `${visibleItems.length} model`);
  const actions = element('div', null, 'actions');
  actions.append(button(selectedCount === visibleItems.length ? 'Seçimi temizle' : 'Tümünü seç', async () => {
    if (selectedCount === visibleItems.length) selectedPoolItems.clear();
    else visibleItems.forEach(([rId, mId]) => selectedPoolItems.add(JSON.stringify([rId, mId])));
    renderPool();
  }));

  if (selectedCount > 0) {
    const getTargets = () => [...selectedPoolItems].map(key => { const [routeId, modelId] = JSON.parse(key); return { routeId, modelId }; });
    const removeLabel = isAllGroup(selectedGroup)
      ? `Tüm havuzlardan çıkar (${selectedCount})`
      : `Havuzdan çıkar (${selectedCount})`;
    const removeSelected = button(removeLabel, async () => {
      const targets = getTargets();
      for (const { routeId, modelId } of targets) {
        const r = settings.config.routes.find(item => item.id === routeId);
        const m = r?.models.find(item => item.id === modelId);
        if (m) m.memberships = isAllGroup(selectedGroup) ? [] : memberships(m).filter(item => item.group !== selectedGroup);
      }
      selectedPoolItems.clear();
      await saveModelsBatch(targets, false, `${targets.length} model havuzdan çıkarıldı.`);
    });
    removeSelected.classList.add('danger');

    const disableBtn = button('Devre dışı bırak', async () => {
      const targets = getTargets();
      for (const { routeId, modelId } of targets) {
        const m = settings.config.routes.find(r => r.id === routeId)?.models.find(item => item.id === modelId);
        if (m) m.enabled = false;
      }
      selectedPoolItems.clear();
      await saveModelsBatch(targets, false, `${targets.length} model devre dışı bırakıldı.`);
    });

    const enableBtn = button('Etkinleştir', async () => {
      const targets = getTargets();
      for (const { routeId, modelId } of targets) {
        const r = settings.config.routes.find(item => item.id === routeId);
        const m = r?.models.find(item => item.id === modelId);
        if (r && m) { m.enabled = true; r.enabled = true; }
      }
      selectedPoolItems.clear();
      await saveModelsBatch(targets, true, `${targets.length} model etkinleştirildi.`);
    });

    const hideBtn = button('Gizle', async () => {
      const targets = getTargets();
      const filters = settings.config.modelFilters ||= [];
      for (const { routeId, modelId } of targets) {
        const r = settings.config.routes.find(item => item.id === routeId);
        const m = r?.models.find(item => item.id === modelId);
        const issue = modelIssueInfo(r, m || { id: modelId }, snapshot?.quotas?.[routeId], quotaErrors[routeId]);
        const reason = (issue.state === 'auth_error' || issue.state === 'subscription_error') ? 'auth_issue' : issue.isUnknown ? 'unknown_quota' : 'manual';
        const rule = { match: 'model', value: modelId, routeId, reason };
        if (!filters.some(item => item.match === rule.match && item.routeId === rule.routeId && item.value === rule.value)) filters.push(rule);
      }
      selectedPoolItems.clear();
      await savePreference('modelFilters');
      notice(`${targets.length} model gizlenenler listesine taşındı.`);
    });

    actions.append(enableBtn, disableBtn, hideBtn, removeSelected);
  }
  bar.replaceChildren(info, actions);
}

async function refreshCatalog(routeId) {
  if (poolDirty) { await runScanImport(routeId); return; }
  settings = await call('refresh_catalog', { routeId });
  baseConfig = structuredClone(settings.config);
  renderPool();
  if (!$('settings').hidden) renderSettings();
  await refresh();
  const countText = Number.isFinite(settings.totalModels) ? `${settings.totalModels} model ` : '';
  notice(`${routeId}: ${countText}senkronize edildi${settings.addedModels ? ` (+${settings.addedModels} yeni model)` : ''}.`);
}

function familyLabel(value) {
  return ({
    argon: 'Argon',
    hydrogen: 'Hydrogen',
    sol: 'Sol',
    terra: 'Terra',
    astra: 'Astra',
    luna: 'Luna',
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    fable: 'Fable',
    gemini: 'Gemini',
    qwen: 'Qwen',
    glm: 'GLM',
    gpt: 'GPT',
    'gpt-oss': 'GPT OSS',
  })[value] || value;
}

function renderCatalog() {
  if (!settings) return;
  withStableView(() => renderCatalogBody());
}

function renderCatalogBody() {
  const scroll = $('pool-models').scrollTop;
  const routes = activeRoutesForDisplay();
  const billingFilter = $('billing-filter').value;
  const all = routes.flatMap(route =>
    route.models
      .filter(model =>
        !modelFiltered(settings.config.modelFilters, route.id, model.id)
        && entryMatchesQuotaFilter(route, model)
        && billingMatches(route, model, billingFilter),
      )
      .map(model => ({ route, model })),
  );

  const search = $('pool-search').value.trim().toLocaleLowerCase('tr');
  const searched = search
    ? all.filter(({ route, model }) => searchHaystack(route, model).includes(search))
    : all;

  const viewMode = $('catalog-view').value;
  let filtered = searched;

  if (viewMode === 'all') {
    $('route-nav').replaceChildren();
    $('catalog-status').replaceChildren(element('small', `Tüm araç ve abonelikler bir arada (${searched.length} model)`));
  } else if (viewMode === 'email') {
    filtered = renderEmailHierarchyNav(
      $('route-nav'),
      searched,
      selectedEmail || '__all__',
      id => {
        selectedEmail = id;
        selectedFamily = '__all__';
        selectedCatalogItems.clear();
        rememberView();
        $('pool-models').scrollTop = 0;
        renderCatalog();
      },
      selectedFamily || '__all__',
      famId => {
        selectedFamily = famId;
        selectedCatalogItems.clear();
        rememberView();
        $('pool-models').scrollTop = 0;
        renderCatalog();
      },
    );
    const activeMail = selectedEmail && selectedEmail !== '__all__' ? (selectedEmail === '__no_email__' ? 'E-postasız / API' : selectedEmail) : 'Tüm hesaplar';
    const activeFam = selectedFamily && selectedFamily !== '__all__' ? ` · ${familyLabel(selectedFamily)}` : '';
    $('catalog-status').replaceChildren(element('small', `${activeMail}${activeFam} · Hesap bazlı model görünümü (${filtered.length} model).`));
  } else {
    const hierarchy = renderHierarchyNav($('route-nav'), searched, catalogNav, next => {
      catalogNav = next;
      selectedCatalogItems.clear();
      rememberView();
      $('pool-models').scrollTop = 0;
      renderCatalog();
    });
    filtered = hierarchy.filtered;
    const status = element('div', null, 'actions');
    const selectedToolObj = hierarchy.tools.find(t => t.id === hierarchy.tool);
    const route = hierarchy.routeId !== '__all__' ? routes.find(r => r.id === hierarchy.routeId) : null;
    const toolText = hierarchy.tool === '__all__' ? 'Tüm araçlar' : (selectedToolObj?.label || hierarchy.tool);
    const subText = hierarchy.routeId === '__all__'
      ? ` · Tüm abonelikler (${Math.max(0, hierarchy.subscriptions.length - 1)} hesap)`
      : ` · ${route ? `${adapterLabels[route.adapter] || route.adapter} · ${cleanRouteLabel(route, routeEmail(route.id))}` : cleanRouteLabel(route, routeEmail(route?.id))}`;
    const famText = hierarchy.family === '__all__' ? '' : ` · ${familyLabel(hierarchy.family)}`;
    const routeMeta = route
      ? ` · ${billingLabels[route.billing]}${route.api ? ` · ${route.api.baseUrl}` : ''}${route.enabled ? '' : ' · Devre dışı'}`
      : '';
    status.append(element('small', `${toolText}${subText}${famText}${routeMeta} · ${filtered.length} model`));

    if (route && route.adapter !== 'codex' && !route.api && route.billing !== 'free' && !route.trustedSettings) {
      const label = element('label', null, 'trust-field'), check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = route.trustedSettings;
      check.addEventListener('change', () => { route.trustedSettings = check.checked; dirty(); });
      label.append(check, element('span', 'Yerel ayarları ve planı doğruladım'));
      status.append(label);
    }
    $('catalog-status').replaceChildren(status);
  }

  const catalogSort = $('catalog-sort').value;
  const entries = sortModels(filtered, catalogSort, catalogSort === 'family', sortContext(''));
  const visibleCatalogKeys = new Set(entries.map(({ route, model }) => JSON.stringify([route.id, model.id])));
  for (const key of [...selectedCatalogItems]) {
    if (!visibleCatalogKeys.has(key)) selectedCatalogItems.delete(key);
  }
  renderCatalogBatchBar(entries);

  $('pool-models').replaceChildren(...entries.map(({ route, model }, idx) => modelCard(route, model, null, {
    reorderList: entries,
    index: idx,
    scopeGroup: '',
    sortSelectId: 'catalog-sort',
    boardKey: 'catalog',
  })));
  if (!entries.length) {
    $('pool-models').append(element('p', 'Görünür model yok. Filtreleri kontrol edin veya Ayarlar → Modelleri tara seçeneğini kullanın.', 'empty'));
  }
  $('catalog-count').textContent = `${entries.length} model`;
  $('pool-models').scrollTop = scroll;
  updateQuotaToggle();
}

function renderCatalogBatchBar(entries) {
  const bar = $('catalog-batch-bar');
  if (!bar) return;
  if (!entries.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  bar.hidden = false;
  const selectedCount = selectedCatalogItems.size;
  const info = element('span', selectedCount ? `${selectedCount} model seçildi` : `${entries.length} model`);
  const actions = element('div', null, 'actions');
  actions.append(button(selectedCount === entries.length ? 'Seçimi temizle' : 'Tümünü seç', async () => {
    if (selectedCount === entries.length) selectedCatalogItems.clear();
    else entries.forEach(({ route, model }) => selectedCatalogItems.add(JSON.stringify([route.id, model.id])));
    renderCatalog();
  }));

  if (selectedCount > 0) {
    const targets = () => [...selectedCatalogItems].map(key => { const [routeId, modelId] = JSON.parse(key); return { routeId, modelId }; });
    const addSelected = button(`Seçilenleri havuza ekle (${selectedCount})`, async () => {
      openPoolPicker(null, null, targets());
    });
    addSelected.classList.add('primary');

    const disableSelected = button('Devre dışı bırak', async () => {
      const list = targets();
      for (const { routeId, modelId } of list) {
        const m = settings.config.routes.find(r => r.id === routeId)?.models.find(item => item.id === modelId);
        if (m) m.enabled = false;
      }
      selectedCatalogItems.clear();
      await saveModelsBatch(list, false, `${list.length} model devre dışı bırakıldı.`);
    });

    const hideSelected = button(`Gizle (${selectedCount})`, async () => {
      const filters = settings.config.modelFilters ||= [];
      for (const { routeId, modelId } of targets()) {
        const r = settings.config.routes.find(item => item.id === routeId);
        const m = r?.models.find(item => item.id === modelId);
        const issue = modelIssueInfo(r, m || { id: modelId }, snapshot?.quotas?.[routeId], quotaErrors[routeId]);
        const reason = (issue.state === 'auth_error' || issue.state === 'subscription_error') ? 'auth_issue' : issue.isUnknown ? 'unknown_quota' : 'manual';
        const rule = { match: 'model', value: modelId, routeId, reason };
        if (!filters.some(item => item.match === rule.match && item.routeId === rule.routeId && item.value === rule.value)) filters.push(rule);
      }
      const count = selectedCatalogItems.size;
      selectedCatalogItems.clear();
      await savePreference('modelFilters');
      notice(`${count} model katalogdan gizlendi.`);
    });
    actions.append(addSelected, disableSelected, hideSelected);
  }
  bar.replaceChildren(info, actions);
}

function hiddenReasonCategory(route, model) {
  const filters = settings?.config?.modelFilters || [];
  if (isSettingsFiltered(filters, route.id, model.id)) return 'settings';
  const matching = filters.filter(rule => modelFiltered([rule], route.id, model.id));
  const explicitReason = matching.find(r => r.reason)?.reason;
  const issue = modelIssueInfo(route, model, snapshot?.quotas?.[route.id], quotaErrors[route.id]);
  if (['auth_error', 'subscription_error', 'billing_unconfirmed', 'connection_error'].includes(issue.state) || explicitReason === 'auth_issue') {
    return 'auth_issue';
  }
  if (issue.isUnknown || explicitReason === 'unknown_quota') {
    return 'unknown_quota';
  }
  return 'manual';
}

const hiddenReasonLabels = {
  auth_issue: 'Giriş / Abonelik sorunlu',
  unknown_quota: 'Kotası okunamayan',
  manual: 'Elle gizlenen',
  settings: 'Ayarlarda filtrelenen',
};

async function restoreHiddenTargets(targets, successMessage) {
  if (!targets.length) return;
  settings.config.modelFilters = unhideModels(settings.config.modelFilters, settings.config.routes, targets);
  selectedHiddenItems.clear();
  await savePreference('modelFilters');
  notice(successMessage || `${targets.length} model kataloga geri yüklendi.`);
}

function renderHidden() {
  if (!settings || !$('hidden-area')) return;
  const filters = settings.config.modelFilters || [];
  const allHidden = [];
  for (const route of settings.config.routes) {
    for (const model of route.models) {
      if (modelFiltered(filters, route.id, model.id)) {
        allHidden.push({ route, model, reasonKey: hiddenReasonCategory(route, model) });
      }
    }
  }
  const viewMode = $('hidden-view')?.value || 'reason';
  const operationalHidden = allHidden.filter(item => item.reasonKey !== 'settings');
  const settingsHidden = allHidden.filter(item => item.reasonKey === 'settings');
  const scopedHidden = viewMode === 'settings' ? settingsHidden : operationalHidden;
  if ($('hidden-panel-count')) {
    $('hidden-panel-count').textContent = `${operationalHidden.length} model${settingsHidden.length ? ` (+${settingsHidden.length} ayar filtresi)` : ''}`;
  }

  const search = ($('hidden-search')?.value || '').trim().toLocaleLowerCase('tr');
  const searched = search
    ? scopedHidden.filter(({ route, model, reasonKey }) => `${searchHaystack(route, model)} ${hiddenReasonLabels[reasonKey] || ''}`.toLocaleLowerCase('tr').includes(search))
    : scopedHidden;

  let subFiltered = searched;
  if (viewMode === 'all') {
    $('hidden-nav').replaceChildren();
  } else if (viewMode === 'settings') {
    subFiltered = renderHierarchyNav($('hidden-nav'), searched, hiddenNav, next => {
      hiddenNav = next;
      selectedHiddenItems.clear();
      rememberView();
      renderHidden();
    }).filtered;
  } else {
    const reasonItems = ['auth_issue', 'unknown_quota', 'manual']
      .map(id => ({ id, label: hiddenReasonLabels[id], count: searched.filter(e => e.reasonKey === id).length }))
      .filter(g => g.count > 0);
    if (selectedHiddenReason !== '__all__' && !reasonItems.some(r => r.id === selectedHiddenReason)) {
      selectedHiddenReason = '__all__';
    }
    const reasonFiltered = selectedHiddenReason === '__all__'
      ? searched
      : searched.filter(e => e.reasonKey === selectedHiddenReason);
    const extraTopRow = reasonItems.length
      ? {
        label: 'Neden',
        items: [{ id: '__all__', label: 'Tümü', count: searched.length }, ...reasonItems],
        value: selectedHiddenReason,
        onSelect: val => {
          selectedHiddenReason = val;
          selectedHiddenItems.clear();
          rememberView();
          renderHidden();
        },
      }
      : null;

    if (viewMode === 'email') {
      subFiltered = renderEmailHierarchyNav(
        $('hidden-nav'),
        reasonFiltered,
        selectedHiddenSubgroup || '__all__',
        id => {
          selectedHiddenSubgroup = id;
          hiddenNav.family = '__all__';
          selectedHiddenItems.clear();
          rememberView();
          renderHidden();
        },
        hiddenNav.family,
        famId => {
          hiddenNav.family = famId;
          selectedHiddenItems.clear();
          rememberView();
          renderHidden();
        },
        extraTopRow,
      );
    } else {
      subFiltered = renderHierarchyNav($('hidden-nav'), reasonFiltered, hiddenNav, next => {
        hiddenNav = next;
        selectedHiddenItems.clear();
        rememberView();
        renderHidden();
      }, extraTopRow).filtered;
    }
  }

  const sorted = sortModels(subFiltered, $('hidden-sort')?.value || 'status', hiddenNav.family !== '__all__', sortContext(''));
  const visibleHiddenKeys = new Set(sorted.map(({ route, model }) => JSON.stringify([route.id, model.id])));
  for (const key of [...selectedHiddenItems]) {
    if (!visibleHiddenKeys.has(key)) selectedHiddenItems.delete(key);
  }

  // Hidden batch bar
  const bar = $('hidden-batch-bar');
  if (bar) {
    if (!scopedHidden.length) {
      bar.hidden = true;
      bar.replaceChildren();
    } else {
      bar.hidden = false;
      const selectedCount = selectedHiddenItems.size;
      const unknownTargets = scopedHidden.filter(e => e.reasonKey === 'unknown_quota').map(e => ({ routeId: e.route.id, modelId: e.model.id }));
      const authTargets = scopedHidden.filter(e => e.reasonKey === 'auth_issue').map(e => ({ routeId: e.route.id, modelId: e.model.id }));
      const info = element('span', selectedCount ? `${selectedCount} gizli model seçildi` : `${sorted.length} / ${scopedHidden.length} gizlenen model`);
      const actions = element('div', null, 'actions');

      if (sorted.length) {
        actions.append(button(selectedCount === sorted.length ? 'Seçimi temizle' : 'Tümünü seç', async () => {
          if (selectedCount === sorted.length) selectedHiddenItems.clear();
          else sorted.forEach(({ route, model }) => selectedHiddenItems.add(JSON.stringify([route.id, model.id])));
          renderHidden();
        }));
      }
      if (selectedCount > 0) {
        const restoreSelBtn = button(`Seçilenleri geri yükle (${selectedCount})`, async () => {
          const list = [...selectedHiddenItems].map(key => { const [routeId, modelId] = JSON.parse(key); return { routeId, modelId }; });
          await restoreHiddenTargets(list, `${list.length} model kataloga geri yüklendi.`);
        });
        restoreSelBtn.classList.add('primary');
        actions.append(restoreSelBtn);
      }
      if (unknownTargets.length > 0) {
        actions.append(button(`Kotası bilinmeyenleri geri yükle (${unknownTargets.length})`, async () => {
          await restoreHiddenTargets(unknownTargets, `Kotası bilinmeyen ${unknownTargets.length} model geri yüklendi.`);
        }));
      }
      if (authTargets.length > 0) {
        actions.append(button(`Giriş sorunluları geri yükle (${authTargets.length})`, async () => {
          await restoreHiddenTargets(authTargets, `Giriş/abonelik sorunlu ${authTargets.length} model geri yüklendi.`);
        }));
      }
      actions.append(button(`Tümünü geri yükle (${scopedHidden.length})`, async () => {
        const list = scopedHidden.map(e => ({ routeId: e.route.id, modelId: e.model.id }));
        await restoreHiddenTargets(list, viewMode === 'settings' ? 'Ayarlarda filtrelenen tüm modeller geri yüklendi.' : 'Tüm gizlenen modeller geri yüklendi.');
      }));
      bar.replaceChildren(info, actions);
    }
  }

  $('hidden-models').replaceChildren(
    ...(sorted.length
      ? sorted.map(({ route, model }) => modelCard(route, model, null, { hiddenView: true, reasonKey: hiddenReasonCategory(route, model) }))
      : [element('p', scopedHidden.length ? 'Bu alt filtrede gizlenen model yok.' : viewMode === 'settings' ? 'Ayarlarda filtrelenen model yok.' : 'Gizlenen model yok. Model kartlarından "Gizle" düğmesiyle sorunlu veya eski modelleri buraya taşıyabilirsiniz.', 'empty')]),
  );
  updateQuotaToggle();
}

function modelCard(route, model, member, options = {}) {
  const { hiddenView = false, reasonKey = '', reorderList = null, index = -1, scopeGroup = '', sortSelectId = '', boardKey = '' } = options;
  const row = element('div', null, `model-card ${member ? 'membership-row' : hiddenView ? 'hidden-row' : 'catalog-row'}`);
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', `${model.id} · ${route.id}`);
  row.dataset.routeId = route.id;
  row.dataset.modelId = model.id;

  const q = snapshot?.quotas?.[route.id];
  const issue = modelIssueInfo(route, model, q, quotaErrors[route.id] || '');
  if (issue.isDisabled) row.classList.add('is-disabled');
  else if (issue.isError) row.classList.add('is-issue-error');
  else if (issue.isUnknown) row.classList.add('is-issue-unknown');

  const key = JSON.stringify([route.id, model.id]);
  const selectSet = hiddenView ? selectedHiddenItems : member ? selectedPoolItems : selectedCatalogItems;
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'model-select';
  check.checked = selectSet.has(key);
  check.setAttribute('aria-label', `${model.id} · ${route.id} seç`);
  check.addEventListener('change', () => {
    if (check.checked) selectSet.add(key);
    else selectSet.delete(key);
    row.classList.toggle('is-selected', check.checked);
    if (hiddenView) renderHidden();
    else if (member) renderPool();
    else renderCatalog();
  });
  row.classList.toggle('is-selected', check.checked);

  const info = element('div', null, 'model-info');
  const titleRow = element('div', null, 'model-title-row');
  titleRow.append(check, element('strong', model.id));

  if (!hiddenView && reorderList && reorderList.length > 1) {
    const orderControls = element('div', null, 'order-controls');
    const handle = element('span', '⋮⋮', 'drag-handle');
    handle.setAttribute('aria-hidden', 'true');
    handle.title = 'Kartı sürükleyip bırakarak sırala';
    handle.addEventListener('pointerdown', () => { row.draggable = true; });
    handle.addEventListener('pointerup', () => { row.draggable = false; });

    const upBtn = button('↑', async () => { await moveEntryOrder(reorderList, index, index - 1, scopeGroup, sortSelectId); });
    upBtn.className = 'order-btn';
    upBtn.disabled = busy || index <= 0;
    upBtn.dataset.locked = String(index <= 0);
    upBtn.setAttribute('aria-label', `${model.id} modelini yukarı taşı`);
    upBtn.title = 'Yukarı taşı (özel sıra)';

    const downBtn = button('↓', async () => { await moveEntryOrder(reorderList, index, index + 1, scopeGroup, sortSelectId); });
    downBtn.className = 'order-btn';
    downBtn.disabled = busy || index >= reorderList.length - 1;
    downBtn.dataset.locked = String(index >= reorderList.length - 1);
    downBtn.setAttribute('aria-label', `${model.id} modelini aşağı taşı`);
    downBtn.title = 'Aşağı taşı (özel sıra)';

    orderControls.append(handle, upBtn, downBtn);
    titleRow.append(orderControls);

    row.addEventListener('dragstart', event => {
      if (!row.draggable) { event.preventDefault(); return; }
      dragPayload = { boardKey, index, routeId: route.id, modelId: model.id };
      row.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', `${route.id}/${model.id}`);
      }
    });
    row.addEventListener('dragover', event => {
      if (!dragPayload || dragPayload.boardKey !== boardKey || dragPayload.index === index) return;
      event.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => { row.classList.remove('drag-over'); });
    row.addEventListener('drop', event => {
      event.preventDefault();
      row.classList.remove('drag-over');
      if (!dragPayload || dragPayload.boardKey !== boardKey || dragPayload.index === index) return;
      const fromIndex = dragPayload.index;
      dragPayload = null;
      void action(() => moveEntryOrder(reorderList, fromIndex, index, scopeGroup, sortSelectId));
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('is-dragging');
      document.querySelectorAll('.model-card.drag-over').forEach(el => el.classList.remove('drag-over'));
      dragPayload = null;
    });
  }

  const email = routeEmail(route.id);
  const subLabel = cleanRouteLabel(route, email);
  const accountRow = element('div', null, 'model-account-row');
  accountRow.append(element('span', `${adapterLabels[route.adapter] || route.adapter}${route.api ? ' · API' : ''}`, 'model-provider-tag'));
  if (email) {
    accountRow.append(element('span', email, 'model-email-badge'));
  } else {
    accountRow.append(element('span', subLabel, route.profile ? 'model-email-badge' : 'badge subtle'));
  }
  accountRow.append(element('span', billingLabels[model.billing || route.billing] || route.billing, 'badge subtle'));

  const statusRow = element('div', null, 'model-status-row');
  if (issue.isError) {
    statusRow.append(element('span', `! ${issue.badge}`, 'badge error'));
  } else if (issue.isUnknown) {
    statusRow.append(element('span', `? ${issue.badge}`, 'badge warn'));
  } else if (issue.isDisabled) {
    statusRow.append(element('span', `○ ${issue.badge}`, 'badge subtle'));
  }
  if (hiddenView && reasonKey) {
    statusRow.append(element('span', hiddenReasonLabels[reasonKey] || reasonKey, 'badge subtle'));
  }

  info.title = `${model.id} · ${adapterLabels[route.adapter] || route.adapter} · ${subLabel}`;
  accountRow.append(element('span', capabilityLabel(route, model), 'badge subtle capability-badge'));
  info.append(titleRow, accountRow);
  if (statusRow.children.length) info.append(statusRow);

  if (model.enabled === false || !route.enabled) {
    const state = element('div', null, 'model-connection');
    const enable = button('Etkinleştir', async () => {
      if (!activeBillings.has(baseConfig.routes.find(item => item.id === route.id)?.billing)) {
        routeSettings(route);
        notice('Önce bağlantının ödeme / plan türünü doğrulayın.');
        return;
      }
      model.enabled = true;
      route.enabled = true;
      await saveModel(route.id, model.id, true, `${model.id} etkinleştirildi.`);
    });
    enable.setAttribute('aria-label', `${model.id} · ${route.id} modelini etkinleştir`);
    enable.title = 'Bu modeli ve bağlı olduğu bağlantıyı etkinleştir';
    state.append(element('small', route.enabled ? 'Model kapalı' : 'Bağlantı kapalı', 'version-unknown'), enable);
    info.append(state);
  }

  info.append(loginNotice(route, true));
  if (!/\d/.test(model.id)) info.append(element('small', 'Sağlayıcı sürüm bildirmedi', 'version-unknown'));

  const footer = element('div', null, 'model-footer');
  if (hiddenView) {
    const groups = memberships(model);
    footer.append(element('small', groups.length ? `Havuz: ${groups.map(item => groupLabel(item.group)).join(' · ')}` : 'Gizlenen model', 'model-memberships'));
    const actions = element('div', null, 'model-actions');
    const restoreBtn = button('Geri yükle', async () => {
      await restoreHiddenTargets([{ routeId: route.id, modelId: model.id }], `${model.id} (${route.id}) geri yüklendi.`);
    });
    restoreBtn.classList.add('primary');
    actions.append(restoreBtn);
    footer.append(actions);
  } else if (member && isAllGroup(member.group)) {
    const groups = memberships(model);
    footer.append(element('small', groups.map(item => groupLabel(item.group)).join(' · '), 'model-memberships'));
    const actions = element('div', null, 'model-actions');
    const addAnother = button('Ekle', async () => openPoolPicker(route, model));
    addAnother.classList.add('add-model');
    addAnother.title = 'Başka bir havuz kategorisine de ekle';
    const removeAll = button('Havuzdan çıkar', async () => {
      model.memberships = [];
      await saveModel(route.id, model.id, false, `${model.id} tüm havuzlardan çıkarıldı.`);
    });
    actions.append(removeAll, addAnother);
    footer.append(actions);
  } else if (member) {
    const effort = settingField('Varsayılan efor', member.effort || '', value => void action(async () => {
      model.memberships = memberships(model);
      const item = model.memberships.find(item => item.group === selectedGroup);
      if (value) item.effort = value;
      else delete item.effort;
      await saveModel(route.id, model.id);
    }), ['', ...model.efforts], false);
    effort.querySelector('select').setAttribute('aria-label', `${model.id} · ${route.id} efor`);
    const remove = button('Çıkar', async () => {
      model.memberships = memberships(model).filter(item => item.group !== selectedGroup);
      await saveModel(route.id, model.id);
    });
    remove.setAttribute('aria-label', `${model.id} · ${route.id} modelini ${groupLabel(selectedGroup)} havuzundan çıkar`);
    footer.append(effort, remove);
  } else {
    const groups = memberships(model);
    footer.append(element('small', groups.length ? groups.map(item => groupLabel(item.group)).join(' · ') : 'Henüz bir havuzda değil', 'model-memberships'));
    const actions = element('div', null, 'model-actions');
    const hide = button('Gizle', async () => openFilters(route, model));
    hide.setAttribute('aria-label', `${model.id} için filtre ekle`);
    const add = button('Ekle', async () => openPoolPicker(route, model));
    add.classList.add('add-model');
    add.dataset.modelId = model.id;
    add.dataset.routeId = route.id;
    add.setAttribute('aria-label', `${model.id} modelini havuza ekle`);
    actions.append(hide, add);
    footer.append(actions);
  }

  const controls = element('div', null, 'model-test-controls');
  const test = button('Test et', async () => {
    const savedRoute = baseConfig.routes.find(item => item.id === route.id);
    const savedModel = savedRoute?.models.find(item => item.id === model.id);
    if (!savedModel) throw new Error('Modeli test etmeden önce kaydedin.');
    const activeMember = row.classList.contains('membership-row')
      ? (isAllGroup(selectedGroup) ? memberships(savedModel)[0] : memberships(savedModel).find(item => item.group === selectedGroup))
      : null;
    const task = await call('probe_model', { routeId: route.id, modelId: model.id, ...(activeMember ? { group: activeMember.group } : {}) });
    await refresh();
    await openTask(task.id);
  });
  test.setAttribute('aria-label', `${model.id} · ${route.id} modelini test et`);
  test.title = 'Kısa bir metin çağrısı gönderir; bağlantının mevcut kota ve izin kuralları geçerlidir.';

  const toggleEnabled = button(model.enabled === false ? 'Etkinleştir' : 'Devre dışı bırak', async () => {
    if (model.enabled === false) {
      if (!activeBillings.has(baseConfig.routes.find(item => item.id === route.id)?.billing)) {
        routeSettings(route);
        notice('Önce bağlantının ödeme / plan türünü doğrulayın.');
        return;
      }
      model.enabled = true;
      route.enabled = true;
      await saveModel(route.id, model.id, true, `${model.id} etkinleştirildi.`);
    } else {
      model.enabled = false;
      await saveModel(route.id, model.id, false, `${model.id} devre dışı bırakıldı.`);
    }
  });
  toggleEnabled.setAttribute('aria-label', `${model.id} · ${route.id} modelini ${model.enabled === false ? 'etkinleştir' : 'devre dışı bırak'}`);

  const link = button('', async () => { if (link.dataset.taskId) await openTask(link.dataset.taskId); });
  link.className = 'model-call';
  link.hidden = true;
  controls.append(test, toggleEnabled, link);

  row.append(info, quotaCell(route, model), footer, controls);
  const task = snapshot?.tasks.find(task => task.routeId === route.id && task.modelId === model.id);
  if (task) {
    row.classList.toggle('is-active', activeStates.has(task.state));
    link.hidden = false;
    link.textContent = activeStates.has(task.state) ? '● Çalışıyor' : `Son çağrı: ${labels[task.state] || task.state}`;
    link.dataset.taskId = task.id;
  }
  return row;
}

function openFilters(route, model) {
  const filters = settings.config.modelFilters ||= [];
  $('filter-actions').replaceChildren();
  if (route && model) {
    $('filter-heading').textContent = model.id;
    const issue = modelIssueInfo(route, model, snapshot?.quotas?.[route.id], quotaErrors[route.id] || '');
    const reason = (issue.state === 'auth_error' || issue.state === 'subscription_error') ? 'auth_issue' : issue.isUnknown ? 'unknown_quota' : 'manual';
    const rules = [
      ['Bu bağlantıda gizle', { match: 'model', value: model.id, routeId: route.id, reason }],
      ['Bu modeli her yerde gizle', { match: 'model', value: modelIdentity(model.id), reason }],
      [`${familyLabel(modelFamily(model.id))} ailesini gizle`, { match: 'family', value: modelFamily(model.id), reason }],
    ];
    for (const [label, rule] of rules) {
      $('filter-actions').append(button(label, async () => {
        if (!filters.some(item => item.match === rule.match && item.routeId === rule.routeId && item.value === rule.value)) {
          filters.push(rule);
          await savePreference('modelFilters');
        }
        renderPool();
        openFilters();
      }));
    }
  } else {
    $('filter-heading').textContent = 'Gizlenen modeller';
  }
  $('filter-list').replaceChildren(...filters.map((rule, index) => {
    const r = rule.routeId ? settings.config.routes.find(item => item.id === rule.routeId) : null;
    const routeText = r ? `${adapterLabels[r.adapter] || r.adapter} · ${cleanRouteLabel(r, routeEmail(r.id))}` : (rule.routeId || 'Tüm bağlantılar');
    const row = element('div', null, 'filter-row');
    row.append(
      element('span', `${rule.match === 'family' ? `${familyLabel(rule.value)} ailesi` : rule.value} · ${routeText}`),
      button('Göster', async () => {
        filters.splice(index, 1);
        await savePreference('modelFilters');
        renderPool();
        openFilters();
      }),
    );
    return row;
  }));
  if (!filters.length) {
    $('filter-list').append(element('p', 'Gizlenen model yok. Model kartındaki Gizle düğmesiyle filtre ekleyin.', 'hint'));
  }
  if (!$('model-filter-dialog').open) $('model-filter-dialog').showModal();
  else $('close-filters').focus();
}

$('open-filters').addEventListener('click', () => openFilters());
$('close-filters').addEventListener('click', () => $('model-filter-dialog').close());
$('model-filter-dialog').addEventListener('close', () => $('open-filters').focus());

function renderCategoryEditor() {
  const cats = categoriesOf(settings.config);
  const memberCounts = Object.fromEntries(cats.map(cat => [cat.id, 0]));
  for (const route of settings.config.routes || []) {
    for (const model of route.models || []) {
      for (const m of memberships(model)) {
        if (m.group in memberCounts) memberCounts[m.group] += 1;
      }
    }
  }
  const stamp = JSON.stringify({ cats, memberCounts });
  if (stamp === categoryEditorStamp) return;
  categoryEditorStamp = stamp;

  if ($('category-presets')) {
    $('category-presets').replaceChildren(
      element('small', 'Hızlı ekle:'),
      ...categoryPresetDefs.map(preset => {
        const exists = cats.some(c => c.name.toLocaleLowerCase('tr') === preset.name.toLocaleLowerCase('tr'));
        const btn = button(`+ ${preset.name}`, async () => {
          settings.config.categories ||= [];
          if (settings.config.categories.some(c => c.name.toLocaleLowerCase('tr') === preset.name.toLocaleLowerCase('tr'))) return;
          settings.config.categories.push({ id: `category-${preset.id}-${crypto.randomUUID().slice(0, 6)}`, name: preset.name });
          await savePreference('categories');
          notice(`${preset.name} kategorisi eklendi.`);
        });
        btn.disabled = busy || exists;
        btn.dataset.locked = String(exists);
        return btn;
      }),
    );
  }

  $('category-list').replaceChildren(...cats.map((category, idx) => {
    const row = element('div', null, 'actions category-row');
    const countBadge = element('span', `${memberCounts[category.id] || 0} model`, 'badge subtle');
    const name = document.createElement('input');
    name.value = category.name;
    name.maxLength = 100;
    name.setAttribute('aria-label', `${category.id} kategori adı`);

    const up = button('↑', async () => {
      const list = settings.config.categories;
      [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
      await savePreference('categories');
    });
    up.disabled = busy || idx === 0;
    up.dataset.locked = String(idx === 0);
    up.setAttribute('aria-label', `${category.name} kategorisini yukarı taşı`);

    const down = button('↓', async () => {
      const list = settings.config.categories;
      [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]];
      await savePreference('categories');
    });
    down.disabled = busy || idx === cats.length - 1;
    down.dataset.locked = String(idx === cats.length - 1);
    down.setAttribute('aria-label', `${category.name} kategorisini aşağı taşı`);

    row.append(
      name,
      countBadge,
      up,
      down,
      button('Adı kaydet', async () => {
        if (!name.value.trim()) throw new Error('Kategori adı gerekli.');
        category.name = name.value.trim();
        await savePreference('categories');
      }),
      button('Kategoriyi kaldır', async () => {
        const before = structuredClone(baseConfig), draft = structuredClone(settings.config);
        removeCategory(draft, category.id);
        const config = structuredClone(before);
        removeCategory(config, category.id);
        const saved = await call('save', { ...settings, config });
        settings = { ...saved, config: mergeScanDraft(saved.config, before, draft) };
        baseConfig = structuredClone(saved.config);
        poolDirty = JSON.stringify(settings.config) !== JSON.stringify(saved.config);
        renderPool();
        await refresh();
        notice('Kategori kaldırıldı; modeller katalogda korunur.');
      }),
    );
    return row;
  }));
}

$('manage-categories').addEventListener('click', () => { $('category-editor').open = !$('category-editor').open; });
$('add-category').addEventListener('click', () => void action(async () => {
  const name = $('category-name').value.trim();
  if (!name) throw new Error('Kategori adı gerekli.');
  settings.config.categories.push({ id: 'category-' + crypto.randomUUID(), name });
  await savePreference('categories');
  $('category-name').value = '';
  notice('Kategori eklendi.');
}));

async function savePreference(key) {
  dirty();
  const before = structuredClone(baseConfig), draft = structuredClone(settings.config);
  const config = preferenceSaveConfig(before, draft, key);
  const saved = await call('save', { ...settings, config });
  settings = { ...saved, config: mergeScanDraft(saved.config, before, draft) };
  poolDirty = JSON.stringify(settings.config) !== JSON.stringify(saved.config);
  updateSave();
  renderPool();
  if (!$('settings').hidden) renderSettings();
  await refresh();
}

function routeSettings(route) {
  selectedSettingsTool = route.adapter;
  selectedSettingsRoute.set(route.adapter, route.id);
  rememberView();
  switchPage('settings');
}

function loginNotice(route, compact = false) {
  const q = snapshot?.quotas?.[route.id], box = element('div', null, `login-notice${compact ? ' model-connection' : ''}`);
  const native = !route.api && !['custom', 'lmstudio', 'ollama', 'omniroute'].includes(route.adapter);
  const email = routeEmail(route.id);
  const qwenVerified = route.adapter === 'qwen' && q?.auth === 'verified';
  const activeSession = Boolean(q && (q.status === 'available' || q.status === 'rate_limited' || q.windows?.length > 0)) || Boolean(email && q?.status !== 'auth_required');
  const unverified = !activeSession && (!q || ['auth_required', 'error'].includes(q.status) || q.auth === 'unknown' || (q.status === 'unknown' && q.auth !== 'verified'));
  if (qwenVerified) {
    box.append(element('span', q.note || 'Qwen API anahtarı doğrulandı · kota yüzdesi sağlayıcıdan alınamıyor'));
    box.append(button('Hesabı değiştir', async () => { const result = await call('login', { routeId: route.id }); notice(result.message); }));
    const check = button(compact ? '↻' : 'Kontrol et', async () => { await refreshQuotas(route.id); await refresh(); renderPool(); });
    check.setAttribute('aria-label', `${route.id} bağlantısını ve kota durumunu kontrol et`);
    check.title = 'Bağlantıyı ve kota durumunu kontrol et';
    box.append(check);
    return box;
  }
  if (!unverified && !(route.adapter !== 'codex' && !route.api && !route.trustedSettings)) {
    if (!compact && native) {
      box.append(element('span', `Oturum açık${email ? `: ${email}` : ''}`, 'badge ok'));
      box.append(button('Hesabı değiştir / Yeniden giriş yap', async () => { const result = await call('login', { routeId: route.id }); notice(result.message); }));
      const check = button('Kotayı kontrol et', async () => { await refreshQuotas(route.id); await refresh(); renderPool(); if (!$('settings').hidden) renderSettings(); });
      box.append(check);
    }
    return box;
  }
  const configured = q?.auth === 'credentials_present' || Boolean(email);
  const statusLine = q?.status === 'auth_required' ? 'Giriş gerekli'
    : q?.status === 'available' && q?.note ? q.note
    : configured ? 'Kimlik bilgisi kayıtlı' : 'Oturum doğrulanmadı';
  box.append(element('span', statusLine));
  if (native) box.append(button(configured ? 'Yeniden giriş yap' : 'Giriş yap', async () => { const result = await call('login', { routeId: route.id }); notice(result.message); }));
  if (route.api || (route.adapter !== 'codex' && !route.trustedSettings)) box.append(button('Ayarlar', async () => routeSettings(route)));
  const check = button(compact ? '↻' : 'Kontrol et', async () => { await refreshQuotas(route.id); await refresh(); renderPool(); if (!$('settings').hidden) renderSettings(); });
  check.setAttribute('aria-label', `${route.id} giriş durumunu kontrol et`);
  check.title = 'Giriş durumunu kontrol et';
  box.append(check);
  return box;
}

function openPoolPicker(route, model, batchTargets = null) {
  if (batchTargets && batchTargets.length) {
    pendingPoolBatch = batchTargets;
    pendingPoolModel = null;
    $('add-pool-model').textContent = `${batchTargets.length} seçili model`;
    $('add-pool-effort').replaceChildren(new Option('Mevcut eforu koru', 'preserve'), new Option('CLI varsayılanı', ''), ...['low', 'medium', 'high'].map(effort => new Option(effortLabel(effort), effort)));
    $('add-pool-targets').replaceChildren(...poolGroups().map(group => button(groupLabel(group), async () => {
      const effortVal = $('add-pool-effort').value;
      for (const { routeId, modelId } of pendingPoolBatch) {
        const targetRoute = settings.config.routes.find(item => item.id === routeId);
        const targetModel = targetRoute?.models.find(item => item.id === modelId);
        if (!targetModel) continue;
        if (!activeBillings.has(targetRoute.billing)) throw new Error(`${targetRoute.id}: Bağlantı ayarlarından bu aracın plan türünü doğrulayın.`);
        const member = memberships(targetModel).find(item => item.group === group);
        const eff = effortVal === 'preserve' ? (member?.effort || '') : (targetModel.efforts?.includes(effortVal) ? effortVal : '');
        addMembership(targetModel, group, eff);
        targetModel.enabled = true;
        targetRoute.enabled = true;
      }
      const targets = [...pendingPoolBatch];
      $('add-pool-dialog').close();
      selectedCatalogItems.clear();
      await saveModelsBatch(targets, true, `${targets.length} model ${groupLabel(group)} havuzuna eklendi.`);
    })));
    $('add-pool-dialog').showModal();
    return;
  }
  pendingPoolBatch = null;
  pendingPoolModel = { routeId: route.id, modelId: model.id };
  $('add-pool-model').textContent = model.id;
  $('add-pool-effort').replaceChildren(...(memberships(model).length ? [new Option('Mevcut eforu koru', 'preserve')] : []), new Option('CLI varsayılanı', ''), ...model.efforts.map(effort => new Option(effortLabel(effort), effort)));
  $('add-pool-targets').replaceChildren(...poolGroups().map(group => {
    const existing = memberships(model).find(member => member.group === group);
    return button(`${groupLabel(group)}${existing ? ' · ekli' : ''}`, async () => {
      const targetRoute = settings.config.routes.find(item => item.id === pendingPoolModel?.routeId);
      const targetModel = targetRoute?.models.find(item => item.id === pendingPoolModel?.modelId);
      if (!targetModel) throw new Error('Model kataloğu değişti. Modeli yeniden seçin.');
      if (!activeBillings.has(targetRoute.billing)) throw new Error('Bağlantı ayarlarından bu aracın plan türünü doğrulayın.');
      const member = memberships(targetModel).find(item => item.group === group);
      const changed = addMembership(targetModel, group, $('add-pool-effort').value === 'preserve' ? member?.effort || '' : $('add-pool-effort').value);
      const enabled = targetModel.enabled && targetRoute.enabled;
      targetModel.enabled = true;
      targetRoute.enabled = true;
      $('add-pool-dialog').close();
      if (changed || !enabled || poolDirty) await saveModel(targetRoute.id, targetModel.id, true);
      else renderPool();
      [...$('pool-models').querySelectorAll('.add-model')].find(node => node.dataset.modelId === targetModel.id && node.dataset.routeId === targetRoute.id)?.focus();
      notice(`${targetModel.id}, ${groupLabel(group)} havuzunda.${snapshot?.quotas?.[targetRoute.id]?.status === 'auth_required' ? ' Kullanmak için Giriş yap düğmesiyle oturum açın.' : ''}`);
    });
  }));
  $('add-pool-dialog').showModal();
}

$('close-add-pool').addEventListener('click', () => $('add-pool-dialog').close());
$('add-pool-dialog').addEventListener('close', () => { pendingPoolModel = null; pendingPoolBatch = null; });

async function refreshQuotas(routeId) {
  if (quotasRefreshing || serviceStopped) return;
  quotasRefreshing = true;
  $('refresh-quotas').textContent = 'Limitler sorgulanıyor…';
  renderPool();
  try {
    const result = await call('quotas', { ...(routeId ? { routeId } : {}), force: true });
    snapshot.quotas = { ...snapshot.quotas, ...result.quotas };
    quotaErrors = routeId ? { ...quotaErrors, [routeId]: result.errors[routeId] } : result.errors;
  } catch (error) { notice(error.message, true); }
  finally {
    quotasRefreshing = false;
    $('refresh-quotas').textContent = 'Kotaları yenile';
    renderPool();
  }
}
$('refresh-quotas').addEventListener('click', () => { void refreshQuotas(); });

const taskModeLabel = task => task.mode === 'execute' ? 'İcra · dosya / araç' : task.mode === 'response' ? 'Yanıt · analiz' : task.kind === 'write' ? 'Yazma · eski protokol' : 'Yanıt / okuma';

function taskDetails(task) {
  const metadata = element('dl', null, 'call-metadata');
  metadata.append(element('dt', 'Çalışma modu'), element('dd', taskModeLabel(task)));
  for (const [label, value] of [
    ['Durum', labels[task.state] || task.state],
    ['Bekleme nedeni', ({ WORKSPACE_REVIEW_REQUIRED: 'Önceki dosya değişikliklerinin incelenmesi bekleniyor', WORKSPACE_BUSY: 'Çalışma klasöründe başka bir iş var', WORKER_LIMIT: 'Boş işçi bekleniyor' })[task.queueReason]],
    ['Engelleyen görev', task.blockedBy],
    ['İstemci', task.clientLabel || 'Bilinmeyen istemci'],
    ['Bağlantı', task.routeId],
    ['Model', task.modelId],
    ['Havuz', groupLabel(task.group)],
    ['Efor', effortLabel(task.effort)],
    ['Başlangıç', new Date(task.created).toLocaleString('tr-TR')],
    ['Çalışma klasörü', task.workspace],
    ['CLI’ın bildirdiği model', task.reportedModel],
  ]) {
    if (value) metadata.append(element('dt', label), element('dd', value));
  }
  const errors = {
    SUBSCRIPTION_REQUIRED: 'Bu CLI için gerekli etkin abonelik/plan doğrulanamadı.',
    AUTH_REQUIRED: 'CLI oturumu veya sağlayıcı anahtarı doğrulanamadı. Giriş durumunu kontrol edin.',
    PROVIDER_RESTRICTION: 'Sağlayıcı bu CLI erişim yolunu kabul etmiyor. Ücretli başka bir yola otomatik geçilmedi.',
    QUOTA_EXHAUSTED: 'Sağlayıcı kota veya bakiye sınırı bildirdi.',
    MODEL_UNAVAILABLE: 'Seçilen model bu sağlayıcıda kullanılamıyor. Kataloğu yenileyin.',
    PERMISSION_REQUIRED: 'CLI çalışma alanı veya izin onayı gerekiyor.',
    SETTINGS_NOT_TRUSTED: 'Yerel CLI ayarları henüz doğrulanmadı. Bağlantı ayarlarını kontrol edin.',
    CLI_FAILED: 'CLI çağrısı başarısız oldu; sağlayıcı veya CLI kurulumunu kontrol edin.',
  };
  const result = task.historyExpired
    ? 'Bu çağrının ayrıntıları saklama süresi dolduğu için temizlendi.'
    : task.result || errors[task.error] || task.error || (task.queueReason === 'WORKSPACE_REVIEW_REQUIRED' ? 'İşçi başlamadı: önceki yazma görevinin dosya incelemesi bekleniyor.' : activeStates.has(task.state) ? 'Çağrı devam ediyor; sonuç burada güncellenecek.' : 'Bu çağrı sonuç metni bildirmedi.');
  const nodes = [metadata, element('h3', 'İstek'), element('div', task.prompt || 'İstek metni bulunmuyor.', 'call-text'), element('h3', 'Yanıt'), element('div', result, `call-text${task.error ? ' call-error' : ''}`)];
  if (task.report) {
    nodes.splice(-2);
    const report = task.report;
    nodes.push(element('h3', 'İcra raporu'), element('p', `${({ completed: 'Tamamlandı', partial: 'Kısmen tamamlandı', blocked: 'Engellendi' })[report.status] || report.status} · ${report.summary}`, 'call-text'));
    for (const [title, rows] of [
      ['Değişen dosyalar', report.files.map(row => `${row.path} — ${row.change}`)],
      ['Kontroller', report.checks.map(row => `${row.command} — ${({ passed: 'Başarılı', failed: 'Başarısız', not_run: 'Çalıştırılmadı' })[row.outcome]}`)],
      ['Araştırma kaynakları', report.research.map(row => `${row.source} — ${row.finding}`)],
      ['Engeller / kalan işler', report.blockers],
    ]) {
      nodes.push(element('h4', title));
      const list = element('ul', null, 'call-text');
      list.append(...(rows.length ? rows : ['Bildirilmedi.']).map(row => element('li', row)));
      nodes.push(list);
    }
  }
  if (task.notifications?.length) nodes.push(element('h3', 'Bildirimler'), ...task.notifications.map(note => element('div', note, 'call-text')));
  if (task.errorDetail) nodes.push(element('h3', 'Araç hatası'), element('div', task.errorDetail, 'call-text call-error'));
  if (task.error === 'PERMISSION_REQUIRED') nodes.push(element('p', 'CLI araç izni reddedildi. Araç/komut ayrıntısı için yerel CLI izinlerini inceleyin; havuz izinleri değiştirmedi ve görevi yeniden çalıştırmadı.', 'call-error'));
  if (task.error === 'INVALID_REPORT') nodes.push(element('p', 'İcra raporu beklenen biçimde değil. Dosyaları ve yukarıdaki özgün çıktıyı inceleyin; görev yeniden çalıştırılmadı.', 'call-error'));
  if (task.error === 'WORK_INCOMPLETE') nodes.push(element('p', 'Alt ajan işi eksik veya engellenmiş bildirdi. Rapordaki kalan işleri inceleyin.', 'call-error'));
  if (task.events?.length) {
    const events = element('details', null, 'call-events');
    events.append(element('summary', 'İşlem adımları'));
    for (const event of task.events) events.append(element('p', `${event.created ? `${new Date(event.created).toLocaleTimeString('tr-TR')} · ` : ''}${labels[event.state] || event.state || event.type || 'Bilgi'}${event.detail ? ` · ${event.detail}` : ''}`));
    nodes.push(events);
  }
  return nodes;
}

async function openTask(id, force = true) {
  const summary = snapshot?.tasks.find(task => task.id === id), stamp = `${id}:${summary?.updated}`;
  if (!force && stamp === selectedTaskStamp) return;
  const task = await call('task', { taskId: id });
  selectedTask = id;
  selectedTaskStamp = stamp;
  showDetail(task);
}

function renderCalls() {
  const focusedId = document.activeElement?.id;
  const allTasks = snapshot?.tasks || [];
  const callSearch = ($('calls-search')?.value || '').trim().toLocaleLowerCase('tr');
  const stateFilter = $('calls-state-filter')?.value || 'all';

  if ($('calls-kpi')) {
    const kpiCounts = [
      ['Toplam', allTasks.length, 'subtle'],
      ['Çalışan', allTasks.filter(t => activeStates.has(t.state)).length, 'info'],
      ['Tamamlanan', allTasks.filter(t => t.state === 'succeeded').length, 'ok'],
      ['Başarısız', allTasks.filter(t => ['failed', 'timed_out', 'cancelled'].includes(t.state)).length, 'error'],
      ['İnceleme', allTasks.filter(t => t.state === 'needs_review').length, 'warn'],
    ];
    $('calls-kpi').replaceChildren(...kpiCounts.map(([label, count, tone]) => element('span', `${label}: ${count}`, `badge ${tone}`)));
  }

  const tasks = allTasks.filter(task => {
    if (stateFilter === 'active' && !activeStates.has(task.state)) return false;
    if (stateFilter === 'succeeded' && task.state !== 'succeeded') return false;
    if (stateFilter === 'failed' && !['failed', 'timed_out', 'cancelled'].includes(task.state)) return false;
    if (stateFilter === 'needs_review' && task.state !== 'needs_review') return false;
    if (!callSearch) return true;
    const hay = `${task.modelId} ${task.clientLabel || ''} ${task.routeId} ${groupLabel(task.group)} ${task.prompt || ''}`.toLocaleLowerCase('tr');
    return hay.includes(callSearch);
  });

  const active = tasks.filter(task => activeStates.has(task.state));
  const recent = tasks.filter(task => !activeStates.has(task.state)).slice(0, 50);
  $('active-call-count').textContent = active.length;
  $('recent-call-count').textContent = recent.length;

  for (const [id, entries, empty] of [['active-calls', active, 'Şu anda çalışan çağrı yok.'], ['recent-calls', recent, 'Henüz tamamlanan çağrı yok.']]) {
    $(id).replaceChildren(...(entries.length ? entries.map(task => {
      const row = element('article', null, `call-row${activeStates.has(task.state) ? ' is-active' : ''}`), title = element('div', null, 'task-title');
      const stateTone = task.state === 'succeeded' ? 'ok' : ['running', 'starting', 'cancelling'].includes(task.state) ? 'info' : task.state === 'needs_review' ? 'warn' : ['failed', 'timed_out'].includes(task.state) ? 'error' : 'subtle';
      title.append(element('strong', task.modelId), element('span', labels[task.state] || task.state, `badge ${stateTone}`));
      const info = element('div');
      info.append(
        title,
        element('small', `${taskModeLabel(task)} · ${task.clientLabel || 'Bilinmeyen istemci'} · ${task.routeId} · ${groupLabel(task.group)} · ${effortLabel(task.effort)}`),
        element('small', new Date(task.created).toLocaleString('tr-TR')),
      );
      const actions = element('div', null, 'actions'), inspect = button('Ayrıntılar', async () => { await openTask(task.id); });
      inspect.id = `result-${task.id}`;
      actions.append(inspect);
      if (['queued', 'starting', 'running'].includes(task.state)) {
        const cancel = button('Durdur', async () => { await call('cancel', { taskId: task.id }); await refresh(); });
        cancel.id = `cancel-${task.id}`;
        actions.append(cancel);
      }
      if (task.state === 'needs_review') {
        const resolveBtn = button('İncelemeyi kapat', async () => { await call('resolve', { taskId: task.id, outcome: 'approved' }); await refresh(); notice('İnceleme kapatıldı.'); });
        const deleteReviewBtn = button('Kapat ve sil', async () => { await call('delete_task', { taskId: task.id, resolveFirst: true }); await refresh(); notice('Çağrı silindi.'); });
        deleteReviewBtn.classList.add('danger');
        actions.append(resolveBtn, deleteReviewBtn);
      } else if (!activeStates.has(task.state)) {
        const delBtn = button('Sil', async () => {
          await call('delete_task', { taskId: task.id });
          if (selectedTask === task.id) { $('detail').close(); $('detail').hidden = true; selectedTask = null; }
          await refresh();
          notice('Çağrı silindi.');
        });
        delBtn.classList.add('danger');
        actions.append(delBtn);
      }
      row.append(info, actions);
      return row;
    }) : [element('p', empty, 'empty')]));
  }
  if (focusedId?.startsWith('result-') || focusedId?.startsWith('cancel-')) $(focusedId)?.focus({ preventScroll: true });
}

$('calls-search')?.addEventListener('input', () => renderCalls());
$('calls-state-filter')?.addEventListener('change', () => renderCalls());

function updateCardActivity() {
  document.querySelectorAll('.model-card').forEach(card => {
    const task = snapshot?.tasks.find(task => task.routeId === card.dataset.routeId && task.modelId === card.dataset.modelId);
    card.classList.toggle('is-active', Boolean(task && activeStates.has(task.state)));
    const link = card.querySelector('.model-call');
    if (!link) return;
    link.hidden = !task;
    link.textContent = task ? activeStates.has(task.state) ? '● Çalışıyor' : `Son çağrı: ${labels[task.state] || task.state}` : '';
    link.dataset.taskId = task?.id || '';
  });
}

$('clear-history').addEventListener('click', async () => {
  try {
    const result = await call('clear_history');
    $('detail').close();
    $('detail').hidden = true;
    selectedTask = null;
    selectedTaskStamp = '';
    await refresh();
    notice(`${result.removed} tamamlanan/başarısız çağrı temizlendi.`);
  } catch (error) { notice(error.message, true); }
});
$('clear-all-history')?.addEventListener('click', async () => {
  try {
    const result = await call('clear_history', { includeReview: true });
    $('detail').close();
    $('detail').hidden = true;
    selectedTask = null;
    selectedTaskStamp = '';
    await refresh();
    notice(`${result.removed} çağrı (inceleme bekleyenler dahil) temizlendi.`);
  } catch (error) { notice(error.message, true); }
});

window.addEventListener('beforeunload', event => {
  if (poolDirty) { event.preventDefault(); event.returnValue = ''; }
});

function fillOriginPlaceholders() {
  const origin = location.origin;
  for (const node of document.querySelectorAll('[data-origin]')) node.textContent = origin;
}

void refresh().then(() => {
  fillOriginPlaceholders();
  if (snapshot) {
    void refreshQuotas();
    void autoSyncCatalogs();
  }
});
refreshIntervalId = setInterval(() => { if (!document.hidden && !busy && !serviceStopped) void refresh(); }, 5000);
quotaIntervalId = setInterval(() => { if (!document.hidden && snapshot && !busy && !serviceStopped) void refreshQuotas(); }, 60000);
catalogIntervalId = setInterval(() => { if (!document.hidden && snapshot && !busy && !poolDirty && !serviceStopped) void autoSyncCatalogs(); }, 600_000);
