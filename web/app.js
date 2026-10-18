import { memberships, mergeScanDraft } from '/pool-state.js';
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
let skills = [];
let poolDirty = false;
let selectedRoute = '';
let selectedGroup = 'high';
let catalogPage = 0;
let quotasRefreshing = false;
let quotaErrors = {};
const catalogEfforts = new Map();
const adapterLabels = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', zcode: 'ZCode', qwen: 'Qwen', mcode: 'MiniMax Code', mmx: 'MiniMax CLI', kimi: 'Kimi', mimo: 'MiMo', agy: 'Antigravity', omniroute: 'OmniRoute', lmstudio: 'LM Studio', ollama: 'Ollama', hermes: 'Hermes', aider: 'Aider', kilocode: 'Kilo', custom: 'Özel araç' };
const strengthGroups = ['high', 'medium', 'low'];

const groupLabels = { high: 'Yüksek', medium: 'Orta', low: 'Hafif', unassigned: 'Sınıflandırılmamış' };
const groupLabel = group => Object.hasOwn(groupLabels, group) ? groupLabels[group] : group;
function dirty() { poolDirty = true; $('save-pool').textContent = 'Değişiklikleri kaydet'; }



function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(message, error = false) { $('notice').textContent = message; $('notice').title = message; $('notice').classList.toggle('error', error); }
async function call(operation, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), operation === 'pick_folder' ? 185_000 : ['scan_import', 'quotas'].includes(operation) ? 90_000 : 30_000);
  try {
    const response = await fetch('/ui', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, payload }), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || 'İşlem tamamlanamadı. Yeniden deneyin.');
    if (operation === 'save') { poolDirty = false; $('save-pool').textContent = 'Havuzu kaydet'; baseConfig = structuredClone(value.config); }
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
  }
}
function availableModels() { return (snapshot?.models || []).filter(model => model.enabled && activeBillings.has(model.billing) && model.kinds.includes($('task-kind').value) && (!$('task-group').value || model.group === $('task-group').value)); }
function updateSubmit() { $('submit').disabled = busy || !availableModels().length || !$('task-prompt').value.trim() || $('voice-input').getAttribute('aria-pressed') === 'true'; }
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
  $('model-empty').textContent = models.length ? 'Seçtiğiniz havuzdan kotası uygun model kullanılır. Modeli açıkça seçerseniz yalnızca o model çalışır.' : 'Bu görev / grupta etkin model yok. Ajan Havuzu ekranından modelleri etkinleştirip kaydedin.';
  $('write-warning').hidden = $('task-kind').value !== 'write';
}
function updateEfforts() {
  const models = availableModels();
  const selected = models.find(model => JSON.stringify([model.routeId, model.id, model.group]) === $('task-model').value);
  const locked = snapshot?.selectionMode === 'manual' || Boolean(selected?.fixedEffort);
  const efforts = locked ? [] : [...new Set((selected ? [selected] : models).flatMap(model => model.efforts))];
  const previous = $('task-effort').value;
  $('task-effort').replaceChildren(new Option(selected?.fixedEffort ? `${selected.fixedEffort} · havuz kuralı` : 'Havuzdaki efor kurallarını uygula', selected?.fixedEffort || ''), ...efforts.map(effort => new Option(effort, effort)));
  if (!locked && efforts.includes(previous)) $('task-effort').value = previous;
  $('task-effort').closest('label').hidden = snapshot?.selectionMode === 'manual';
  $('task-effort').disabled = locked || busy; $('task-effort').dataset.locked = String(locked);
}
function showDetail(value) { $('detail-content').textContent = value.result || JSON.stringify(value, null, 2); $('detail').hidden = false; if (!$('detail').open) $('detail').showModal(); $('detail-heading').tabIndex = -1; $('detail-heading').focus(); }
function button(text, operation) { const node = element('button', text); node.type = 'button'; node.addEventListener('click', () => void action(operation)); return node; }
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
    if (!$('task-workspace').value) $('task-workspace').value = snapshot.workspaceRoots[0] || '';
    if (!settings || (!poolDirty && settings.revision !== snapshot.revision)) { settings = await call('settings'); renderPool(); if (!$('settings').hidden) renderSettings(); }
    renderProjects();
    const previousGroup = $('task-group').value;
    $('task-group').replaceChildren(...(snapshot.selectionMode === 'auto' ? [new Option('Ajan otomatik seçsin', '')] : []), ...strengthGroups.map(group => new Option(groupLabel(group), group)));
    if ([...$('task-group').options].some(option => option.value === previousGroup)) $('task-group').value = previousGroup;
    else $('task-group').value = snapshot.selectionMode === 'manual' ? 'high' : '';
    $('connection-state').textContent = 'Yerel havuza bağlı';
    $('installed-count').textContent = snapshot.installed.filter(cli => cli.status === 'installed').length;
    $('model-count').textContent = new Set(snapshot.models.filter(model => model.enabled && (snapshot.selectionMode === 'auto' || strengthGroups.includes(model.group))).map(model => `${model.routeId}/${model.id}`)).size;
    $('running-count').textContent = snapshot.tasks.filter(task => ['starting', 'running', 'cancelling'].includes(task.state)).length;
    $('review-count').textContent = snapshot.tasks.filter(task => task.state === 'needs_review').length;
    const projectTasks = snapshot.tasks.filter(task => task.workspace === $('task-workspace').value);
    $('task-total').textContent = projectTasks.length;
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
    if (announce || wasOffline) notice('Havuz hazır. Modelleri gruplayın veya Çalışma Alanı’ndan bir görev başlatın.');
  } catch (error) { $('connection-state').textContent = 'Bağlantı yok'; notice(error.message, true); }
  finally { refreshing = false; }
}
function settingField(label, value, update, choices, markDirty = true) {
  const wrapper = element('label', null, 'setting-field'); wrapper.append(element('span', label));
  const input = choices ? document.createElement('select') : document.createElement('input');
  if (choices) input.replaceChildren(...choices.map(choice => new Option(Array.isArray(choice) ? choice[1] : (choice || 'CLI varsayılanı'), Array.isArray(choice) ? choice[0] : choice)));
  else input.maxLength = 100;
  input.value = value;
  input.addEventListener('change', () => { update(input.value); if (markDirty) dirty(); }); wrapper.append(input); return wrapper;
}
function renderSettings() {
  $('workspace-roots').value = settings.config.workspaceRoots.join('\n');
  const previousAdapter = $('new-adapter').value;
  const adapters = snapshot.installed.filter(cli => cli.status === 'installed');
  $('new-adapter').replaceChildren(new Option('CLI seçin', ''), ...adapters.map(cli => new Option(`${cli.label || cli.adapter} (${cli.discoveredModels?.length || 0} model)`, cli.adapter)));
  if (adapters.some(cli => cli.adapter === previousAdapter)) $('new-adapter').value = previousAdapter;
  const billingChoices = Object.entries(billingLabels).map(([k, v]) => [k, v]);
  $('settings-routes').replaceChildren(...settings.config.routes.map(route => {
    const section = element('div', null, 'route-settings');
    const header = element('label', null, 'route-header'); const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.checked = route.enabled; enabled.disabled = !activeBillings.has(route.billing);
    enabled.dataset.locked = String(!activeBillings.has(route.billing));
    enabled.addEventListener('change', () => { route.enabled = enabled.checked; });
    header.append(enabled, element('strong', `${route.id} · ${route.api ? `${route.api.protocol} API (${route.adapter})` : route.adapter}`));
    section.append(header);
    section.append(settingField('Ödeme / plan türü', route.billing, value => {
      route.billing = value;
      enabled.disabled = !activeBillings.has(value);
      enabled.dataset.locked = String(!activeBillings.has(value));
    }, billingChoices));
    if (route.billing === 'paid_api') {
      const autoLabel = element('label', null, 'route-header'); const autoCheck = document.createElement('input');
      autoCheck.type = 'checkbox'; autoCheck.checked = Boolean(route.autoSelect);
      autoCheck.addEventListener('change', () => { route.autoSelect = autoCheck.checked; });
      autoLabel.append(autoCheck, element('span', 'Ücretli API’nin otomatik model seçimine girmesine izin ver')); section.append(autoLabel);
    }
    if (route.api) {
      section.append(settingField('API Base URL', route.api.baseUrl, value => { route.api.baseUrl = value; }));
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
      keyRow.append(keyInput, keyBtn); section.append(keyRow);
    } else if (route.adapter !== 'codex') {
      const trustedLabel = element('label', null, 'route-header'); const trusted = document.createElement('input');
      trusted.type = 'checkbox'; trusted.checked = route.trustedSettings;
      trusted.addEventListener('change', () => { route.trustedSettings = trusted.checked; });
      trustedLabel.append(trusted, element('span', `CLI yerel ayarlarını inceledim (Giriş komutu: ${loginCommandsLabel(route.adapter)})`)); section.append(trustedLabel);
    }
    section.append(settingField('Öncelik (küçük değer önce)', route.priority, value => { route.priority = Number(value); }));
    section.append(settingField('Seçim için asgari kalan kota (%)', route.minRemainingPercent, value => { route.minRemainingPercent = Number(value); }));
    section.append(element('p', 'Modelleri üstteki havuz görünümünden sınıflandırabilirsiniz.', 'hint'));
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
    addModelRow.append(newModelInput, addModelBtn); section.append(addModelRow);
    const routeActions = element('div', null, 'actions');
    routeActions.append(button('Plan / kota durumunu sorgula', async () => { const q = await call('quota', { routeId: route.id }); await refresh(); showDetail(q); }));
    if (!route.api && route.adapter !== 'custom') {
      routeActions.append(button('Model sürümlerini yenile', async () => { await refreshCatalog(route.id); }));
    }
    section.append(routeActions);
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
$('refresh').addEventListener('click', () => void refresh(true));
$('quick-scan-import').addEventListener('click', () => void action(runScanImport));
$('scan-import').addEventListener('click', () => void action(runScanImport));
$('close-detail').addEventListener('click', () => { $('detail').close(); $('detail').hidden = true; ($('workspace-panel').hidden ? $('pool-tab') : $('task-prompt')).focus(); });
$('open-settings').addEventListener('click', () => { renderSettings(); $('settings').hidden = false; $('settings').showModal(); });
$('close-settings').addEventListener('click', () => { $('settings').close(); $('settings').hidden = true; $('open-settings').focus(); });
$('settings').addEventListener('close', () => { $('settings').hidden = true; });
async function saveSettings() {
  settings = await call('save', settings); poolDirty = false; renderSettings(); renderPool(); await refresh(); notice('Havuz kaydedildi. Bağlı ajanlar ve yeni görevler bu grupları kullanır.');
}
$('save-settings').addEventListener('click', () => void action(saveSettings));
$('save-pool').addEventListener('click', () => void action(saveSettings));
$('settings').addEventListener('change', dirty);
$('workspace-roots').addEventListener('input', () => { dirty(); if (settings) settings.config.workspaceRoots = $('workspace-roots').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); });
$('add-route').addEventListener('click', () => void action(async () => {
  const adapter = $('new-adapter').value;
  const billing = $('new-billing').value;
  const cli = snapshot.installed.find(cli => cli.adapter === adapter && cli.executable);
  if (!cli) throw new Error('Kurulu bir CLI seçin.');
  if (!$('subscription-confirmed').checked) throw new Error('Önce CLI’ın seçtiğiniz ödeme/plan türüyle yapılandırıldığını onaylayın.');
  if (!settings.config.workspaceRoots.length) throw new Error('Önce izin verilen bir çalışma klasörü ekleyin.');
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
    request.prompt = [$('task-prompt').value, $('task-goal').value.trim() ? `Hedef / tamamlanma koşulu:\n${$('task-goal').value.trim()}` : '', ...skills.map(skill => `Skill: ${skill.name}\n${skill.text}`)].filter(Boolean).join('\n\n');
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
  const pool = page === 'pool';
  $('pool-panel').hidden = !pool; $('workspace-panel').hidden = pool;
  if (pool) renderPool();
  $('settings').close(); $('settings').hidden = true; $('detail').close(); $('detail').hidden = true;
  for (const [id, active] of [['pool-tab', pool], ['workspace-tab', !pool]]) {
    if (active) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
}
document.querySelector('.skip').addEventListener('click', () => { switchPage('workspace'); $('task-prompt').focus(); updateSubmit(); });
$('pool-tab').addEventListener('click', () => switchPage('pool'));
$('workspace-tab').addEventListener('click', () => switchPage('workspace'));
$('task-group').addEventListener('change', updateModels);
$('task-model').addEventListener('change', updateEfforts);
$('pool-search').addEventListener('input', () => { catalogPage = 0; renderCatalog(); });
$('selection-mode').addEventListener('change', () => { settings.config.selectionMode = $('selection-mode').value; dirty(); renderPool(); });
$('grouping-mode').addEventListener('change', () => { settings.config.groupingMode = $('grouping-mode').value; dirty(); });
$('catalog-prev').addEventListener('click', () => { catalogPage--; renderCatalog(); $('pool-models').scrollTop = 0; });
$('catalog-next').addEventListener('click', () => { catalogPage++; renderCatalog(); $('pool-models').scrollTop = 0; });

function quotaCell(route, model, compact = true) {
  const cell = element('div', null, 'quota-cell');
  const q = snapshot?.quotas?.[route.id];
  const windows = (q?.windows || []).filter(window => !window.models?.length || window.models.some(id => model.id.includes(id)));
  if (compact) {
    const details = element('details', null, 'quota-details');
    const measured = windows.filter(window => Number.isFinite(window.remainingPercent));
    const summary = element('summary', measured.length ? measured.map(window => `${({ five_hour: '5s', seven_day: '7g', opus: 'Opus' })[window.name] || window.name}: %${(100 - window.remainingPercent).toFixed(0)} kullanım`).join(' · ') : quotaErrors[route.id] || (quotasRefreshing ? 'Kota sorgulanıyor…' : q?.status === 'auth_required' ? 'Giriş gerekli' : 'Kota bilinmiyor'));
    summary.title = `${summary.textContent} · kullanım, yenilenme ve ölçüm ayrıntıları`;
    details.append(summary, quotaCell(route, model, false)); cell.append(details); return cell;
  }
  if (windows.length) {
    for (const window of windows) {
      if (!Number.isFinite(window.remainingPercent)) continue;
      const used = Math.max(0, Math.min(100, 100 - window.remainingPercent));
      const line = element('div', null, 'usage-line');
      const name = ({ five_hour: '5 saat', seven_day: '7 gün', opus: 'Opus haftalık' })[window.name] || (window.windowMinutes ? window.windowMinutes >= 1440 ? `${window.windowMinutes / 1440} gün` : `${window.windowMinutes / 60} saat` : window.name);
      line.append(element('span', `${name}: %${used.toFixed(0)} kullanım · %${window.remainingPercent.toFixed(0)} kalan`));
      const bar = document.createElement('progress'); bar.max = 100; bar.value = used; bar.setAttribute('aria-label', `${window.name} kullanım`); line.append(bar); if (window.resetsAt) line.append(element('small', `Yenilenme: ${new Date(typeof window.resetsAt === 'number' && window.resetsAt < 1e12 ? window.resetsAt * 1000 : window.resetsAt).toLocaleString('tr-TR')}`)); cell.append(line);
    }
    cell.append(element('small', `${q.scope === 'model' ? 'Model kotası' : 'Hesap / bağlantı kotası'}${q.observedAt ? ` · ${new Date(q.observedAt).toLocaleTimeString('tr-TR')}` : ''}${Date.now() - Date.parse(q.observedAt) >= 60000 ? ' · eski ölçüm' : ''}${quotaErrors[route.id] ? ' · son sorgu başarısız' : ''}`));
  } else cell.append(element('small', quotaErrors[route.id] || (quotasRefreshing ? 'Kota sorgulanıyor…' : q?.status === 'auth_required' ? 'Giriş gerekli' : q ? 'Sağlayıcı yüzde kotası bildirmiyor' : 'Kota henüz sorgulanmadı')));
  return cell;
}
function renderPool() {
  if (!settings) return;
  $('selection-mode').value = settings.config.selectionMode;
  $('grouping-mode').value = settings.config.groupingMode;
  $('save-pool').textContent = poolDirty ? 'Değişiklikleri kaydet' : 'Havuzu kaydet';
  $('selection-description').textContent = settings.config.selectionMode === 'manual' ? 'Katı mod: ajan yalnızca istediği havuzdaki modelleri, sizin belirlediğiniz eforla kullanır.' : 'Otomatik mod: ajan uygun model ve havuzu seçebilir. Tanımladığınız havuz eforları yine zorunludur.';
  $('group-summary').replaceChildren(...strengthGroups.map(group => {
    const count = settings.config.routes.reduce((total, route) => total + route.models.filter(model => memberships(model).some(member => member.group === group)).length, 0);
    const card = element('button', null, `group-card group-${group}`); card.type = 'button'; card.setAttribute('aria-pressed', String(selectedGroup === group));
    card.append(element('strong', groupLabel(group)), element('span', `${count} model`));
    card.addEventListener('click', () => { selectedGroup = group; catalogPage = 0; renderPool(); }); return card;
  }));
  $('members-heading').textContent = `${groupLabel(selectedGroup)} havuzundaki modeller`;
  $('catalog-heading').textContent = `${groupLabel(selectedGroup)} havuzuna model ekle`;
  const rows = [];
  for (const route of settings.config.routes) for (const model of route.models) {
    const member = memberships(model).find(item => item.group === selectedGroup);
    if (!member) continue;
    const row = element('div', null, 'membership-row');
    const info = element('div'); info.append(element('strong', model.id), element('small', `${adapterLabels[route.adapter] || route.adapter} · ${route.id}${!route.enabled || model.enabled === false ? ' · Kapalı' : route.adapter !== 'codex' && !route.api && route.billing !== 'free' && !route.trustedSettings ? ' · Yerel ayar onayı bekliyor' : ''}${route.billing === 'paid_api' && !route.autoSelect ? ' · Ücretli API otomatik seçimi kapalı' : ''}`));
    row.append(info, quotaCell(route, model), settingField('Bu havuzdaki efor', member.effort || '', value => { model.memberships = memberships(model); const item = model.memberships.find(item => item.group === selectedGroup); if (value) item.effort = value; else delete item.effort; dirty(); }, ['', ...model.efforts]), button('Çıkar', async () => { model.memberships = memberships(model).filter(item => item.group !== selectedGroup); dirty(); renderPool(); }));
    rows.push(row);
  }
  $('pool-members').replaceChildren(...(rows.length ? rows : [element('p', `Bu havuz boş. Aşağıdan Codex, Claude veya başka bir araç seçip modelleri ekleyin.`, 'empty')]));
  renderCatalog();
}
async function refreshCatalog(routeId) {
  // A live refresh is merged through the same scan path so unsaved owner choices survive.
  if (poolDirty) { await runScanImport(routeId); return; }
  settings = await call('refresh_catalog', { routeId }); renderPool(); await refresh(); notice('Model sürümleri güncellendi.');
}
function renderCatalog() {
  if (!settings) return;
  const routes = settings.config.routes;
  if (!routes.some(route => route.id === selectedRoute)) selectedRoute = routes.find(route => route.adapter === 'codex')?.id || routes[0]?.id || '';
  $('route-nav').replaceChildren(...routes.map(route => {
    const node = element('button', `${adapterLabels[route.adapter] || route.adapter}${route.api ? ' API' : ''} (${route.models.length})`); node.type = 'button'; node.title = route.id;
    node.classList.toggle('selected', route.id === selectedRoute); node.setAttribute('aria-pressed', String(route.id === selectedRoute));
    node.addEventListener('click', () => { selectedRoute = route.id; catalogPage = 0; $('pool-search').value = ''; renderCatalog(); }); return node;
  }));
  const route = routes.find(route => route.id === selectedRoute);
  if (!route) { $('catalog-status').replaceChildren(); $('pool-models').replaceChildren(element('p', 'Modelleri tara düğmesiyle kurulu araçları bulun.', 'empty')); $('catalog-page').textContent = ''; return; }
  const status = element('div', null, 'actions');
  status.append(element('small', `${route.id} · ${billingLabels[route.billing]}${route.api ? ` · ${route.api.baseUrl}` : ['ollama', 'lmstudio'].includes(route.adapter) ? ' · Yerel modeller' : ' · Kurulu araç üzerinden erişim'}`));
  status.append(button('Model sürümlerini al', () => refreshCatalog(route.id)), button('Kota sorgula', async () => { await refreshQuotas(route.id); }));
  if (route.adapter !== 'codex' && !route.api && !route.trustedSettings) {
    const label = element('label', null, 'trust-field'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = route.trustedSettings;
    check.addEventListener('change', () => { route.trustedSettings = check.checked; dirty(); }); label.append(check, element('span', 'Bu aracın yerel ayarlarını ve planını doğruladım')); status.append(label);
  }
  $('catalog-status').replaceChildren(status);
  const search = $('pool-search').value.trim().toLocaleLowerCase('tr');
  const models = route.models.filter(model => `${model.id} ${model.alias}`.toLocaleLowerCase('tr').includes(search));
  const pageSize = 24; const pageCount = Math.max(1, Math.ceil(models.length / pageSize)); catalogPage = Math.max(0, Math.min(catalogPage, pageCount - 1));
  $('pool-models').replaceChildren(...models.slice(catalogPage * pageSize, (catalogPage + 1) * pageSize).map(model => {
    const row = element('div', null, 'catalog-row'); const info = element('div');
    info.append(element('strong', model.id)); info.title = `${model.id}${model.alias !== model.id ? ` · ${model.alias}` : ''}`;
    if (model.alias !== model.id) info.append(element('small', model.alias));
    if (!/\d/.test(model.id)) info.append(element('small', 'Sürüm bildirilmedi · model sürümlerini al', 'version-unknown'));
    const existing = memberships(model).find(item => item.group === selectedGroup);
    const key = JSON.stringify([route.id, model.id, selectedGroup]); const value = catalogEfforts.has(key) ? catalogEfforts.get(key) : existing?.effort || '';
    const effort = settingField('Havuza eklerken efor', value, next => { catalogEfforts.set(key, next); }, ['', ...model.efforts], false);
    const add = button(existing ? 'Eklendi · eforu güncelle' : `${groupLabel(selectedGroup)} havuzuna ekle`, async () => {
      if (!activeBillings.has(route.billing)) throw new Error('Bağlantı ayarlarından bu aracın plan türünü doğrulayın.');
      model.memberships = memberships(model); let member = model.memberships.find(item => item.group === selectedGroup);
      if (!member) { member = { group: selectedGroup }; model.memberships.push(member); }
      const chosen = catalogEfforts.has(key) ? catalogEfforts.get(key) : existing?.effort || '';
      if (chosen) member.effort = chosen; else delete member.effort;
      model.enabled = true; route.enabled = true; dirty(); renderPool();
    });
    row.append(info, quotaCell(route, model), effort, add); return row;
  }));
  if (!models.length) $('pool-models').append(element('p', 'Eşleşen model yok. Model sürümlerini al düğmesini kullanın.', 'empty'));
  $('catalog-page').textContent = `${models.length} model · ${catalogPage + 1} / ${pageCount}`;
  for (const [id, locked] of [['catalog-prev', catalogPage === 0], ['catalog-next', catalogPage >= pageCount - 1]]) { $(id).disabled = locked || busy; $(id).dataset.locked = String(locked); }
}
async function refreshQuotas(routeId) {
  if (quotasRefreshing) return;
  quotasRefreshing = true; $('refresh-quotas').textContent = 'Limitler sorgulanıyor…'; renderPool();
  try {
    const result = await call('quotas', routeId ? { routeId } : {}); snapshot.quotas = { ...snapshot.quotas, ...result.quotas }; quotaErrors = routeId ? { ...quotaErrors, [routeId]: result.errors[routeId] } : result.errors;
  } catch (error) { notice(error.message, true); }
  finally { quotasRefreshing = false; $('refresh-quotas').textContent = 'Kullanım / limitleri yenile'; renderPool(); }
}
$('refresh-quotas').addEventListener('click', () => { void refreshQuotas(); });
function renderProjects() {
  const roots = snapshot?.workspaceRoots || [];
  $('projects').replaceChildren(...roots.map(root => {
    const node = button(root.split(/[\\/]/).filter(Boolean).at(-1) || root, async () => { $('task-workspace').value = root; selectedTask = null; selectedTaskStamp = ''; renderProjects(); $('conversation').replaceChildren(element('p', 'Bu projede yeni bir görev başlatın.', 'empty')); await refresh(); });
    node.title = root; node.className = 'project-button'; node.classList.toggle('selected', root === $('task-workspace').value); return node;
  }));
}
async function openFolders() {
  notice('Windows klasör seçme penceresi açılıyor…');
  const result = await call('pick_folder', { path: $('task-workspace').value || snapshot.workspaceRoots[0] || '' });
  if (!result.path) { notice('Klasör seçimi iptal edildi.'); return; }
  // Save only the selected project root, keeping any unrelated pool draft in memory.
  const view = await call('settings');
  if (!view.config.workspaceRoots.includes(result.path)) view.config.workspaceRoots.push(result.path);
  const saved = await call('save', view);
  if (settings && poolDraft) { settings.config.workspaceRoots = [...new Set([...settings.config.workspaceRoots, result.path])]; settings.revision = saved.revision; poolDirty = true; }
  else settings = saved;
  $('task-workspace').value = result.path; selectedTask = null; selectedTaskStamp = ''; $('conversation').replaceChildren(element('p', 'Bu projede yeni bir görev başlatın.', 'empty')); await refresh(); renderPool(); notice('Proje klasörü seçildi.');
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
  const content = [element('p', `Seçilen: ${task.modelId} · ${task.routeId} · ${groupLabel(task.group || 'unassigned')} · Efor: ${task.effort || 'CLI varsayılanı'} · ${labels[task.state]}`, 'badge subtle'), element('p', task.reportedModel ? `Araç tarafından bildirilen model: ${task.reportedModel}` : 'Çalıştırıcı sürüm kimliğini ayrıca bildirmedi.', 'hint')];
  if (task.prompt) { const prompt = element('details', null, 'user-message'); prompt.append(element('summary', `Görev: ${task.prompt.split('\n\n')[0].slice(0, 200)}`), element('pre', task.prompt)); content.push(prompt); }
  content.push(element('pre', task.result || task.error || task.events?.at(-1)?.detail || labels[task.state], 'agent-message'));
  $('conversation').replaceChildren(...content);
  if (force || task.state === 'succeeded') $('conversation').scrollTop = $('conversation').scrollHeight;
}
$('attach-instructions').addEventListener('click', () => { $('task-instructions').open = !$('task-instructions').open; });
$('new-task').addEventListener('click', () => { selectedTask = null; selectedTaskStamp = ''; submitted = null; $('task-prompt').value = ''; $('task-goal').value = ''; skills = []; renderSkills(); $('conversation').replaceChildren(element('p', 'Yeni görevinizi yazın.', 'empty')); $('task-prompt').focus(); updateSubmit(); });
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
