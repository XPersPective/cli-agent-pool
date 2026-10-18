const $ = id => document.getElementById(id);
const labels = { queued: 'Sırada', starting: 'Başlatılıyor', running: 'Çalışıyor', succeeded: 'Tamamlandı', failed: 'Başarısız', timed_out: 'Süre doldu', cancelling: 'Durduruluyor', cancelled: 'Durduruldu', needs_review: 'Elle inceleme gerekli' };
const billingLabels = { subscription: 'Abonelik', token_plan: 'Token planı', free_credits: 'Günlük / ücretsiz kredi', free: 'Ücretsiz', paid_api: 'Ücretli API', unknown: 'Doğrulanmadı' };
const activeBillings = new Set(['subscription', 'token_plan', 'free_credits', 'free', 'paid_api']);
let snapshot = null;
let settings = null;
let busy = false;
let refreshing = false;
let submitted = null;
let modelSignature = '';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function call(operation, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch('/ui', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, payload }), signal: controller.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || 'İşlem tamamlanamadı. Yeniden deneyin.');
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
    $('submit').disabled = !availableModels().length;
  }
}
function availableModels() { return (snapshot?.models || []).filter(model => model.enabled && activeBillings.has(model.billing) && model.kinds.includes($('task-kind').value)); }
function updateModels() {
  const previous = $('task-model').value;
  const models = availableModels();
  const signature = JSON.stringify(models);
  if (signature !== modelSignature) {
    modelSignature = signature;
    $('task-model').replaceChildren(new Option('Model seçin', ''), ...models.map(model => new Option(`${model.alias} · ${billingLabels[model.billing] || model.billing} · ${model.group} · ${model.routeId}`, `${model.routeId}/${model.id}`)));
    if (models.some(model => `${model.routeId}/${model.id}` === previous)) $('task-model').value = previous;
  }
  $('submit').disabled = busy || !models.length;
  $('model-empty').textContent = models.length ? 'Abonelik, token planı ve ücretsiz modeller önceliklidir; ücretli API açıkça seçildiğinde çalışır.' : 'Bu görev için etkin model yok. Modeller ve bağlantılar bölümünden bir CLI veya API etkinleştirin.';
  $('write-warning').hidden = $('task-kind').value !== 'write';
}
function showDetail(value) { $('detail-content').textContent = value.result || JSON.stringify(value, null, 2); $('detail').hidden = false; $('detail-heading').tabIndex = -1; $('detail-heading').focus(); }
function button(text, operation) { const node = element('button', text); node.type = 'button'; node.addEventListener('click', () => void action(operation)); return node; }
function formatQuotaSummary(conn, q) {
  if (!q) return conn.protocol ? `${conn.protocol.toUpperCase()} API · ${conn.baseUrl}` : `Giriş komutu: ${conn.loginCommand || conn.adapter}`;
  if (q.status === 'auth_required') return `Giriş gerekli: terminalde "${q.loginCommand || conn.loginCommand}" çalıştırın`;
  if (q.windows?.length) return q.windows.map(w => `${w.name}: %${w.remainingPercent} kalan`).join(' · ');
  if (q.subscription === 'active') return 'Etkin token planı doğrulandı';
  if (q.subscription === 'none' && conn.billing === 'free_credits') return 'Token planı yok · Günlük / ücretsiz kredi modu etkin';
  if (q.subscription === 'none') return 'Etkin token planı yok (günlük kredi için free_credits seçin)';
  if (q.endpoint) return `Uç nokta: ${q.endpoint}`;
  return `Durum: ${q.status}`;
}
async function refresh(announce = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const wasOffline = $('connection-state').textContent === 'Bağlantı yok';
    snapshot = await call('snapshot');
    if (!$('task-workspace').value) $('task-workspace').value = snapshot.workspaceRoots[0] || '';
    $('connection-state').textContent = 'Yerel havuza bağlı';
    $('installed-count').textContent = snapshot.installed.filter(cli => cli.status === 'installed').length;
    $('model-count').textContent = snapshot.models.filter(model => model.enabled).length;
    $('running-count').textContent = snapshot.tasks.filter(task => ['starting', 'running', 'cancelling'].includes(task.state)).length;
    $('review-count').textContent = snapshot.tasks.filter(task => task.state === 'needs_review').length;
    $('task-total').textContent = snapshot.tasks.length;
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
      const info = element('div'); info.append(element('strong', cli.adapter));
      info.append(element('small', cli.status === 'installed' ? `Kurulu · Giriş: ${cli.loginCommand}` : 'Bilgisayarda bulunamadı'));
      row.append(info, element('span', cli.status === 'installed' ? 'Kurulu' : 'Bulunamadı', 'provider-state'));
      providerRows.push(row);
    }
    $('providers').replaceChildren(...providerRows);
    const focusedId = document.activeElement?.id;
    $('tasks').replaceChildren(...(snapshot.tasks.length ? snapshot.tasks.map(task => {
      const row = element('div', null, 'task');
      const title = element('div', null, 'task-title'); title.append(element('strong', `${task.modelId} · ${task.routeId}`), element('span', labels[task.state] || task.state, 'badge subtle'));
      const actions = element('div', null, 'actions');
      const resultButton = button('Sonucu görüntüle', async () => showDetail(await call('task', { taskId: task.id }))); resultButton.id = `result-${task.id}`; actions.append(resultButton);
      if (['queued', 'starting', 'running'].includes(task.state)) { const cancelButton = button('Durdur', async () => { showDetail(await call('cancel', { taskId: task.id })); await refresh(); }); cancelButton.id = `cancel-${task.id}`; actions.append(cancelButton); }
      row.append(title, element('small', new Date(task.created).toLocaleString('tr-TR')), actions); return row;
    }) : [element('p', 'Henüz görev yok. İlk görevinizi formdan başlatın.', 'empty')]));
    if (focusedId?.startsWith('result-') || focusedId?.startsWith('cancel-')) $(focusedId)?.focus({ preventScroll: true });
    updateModels();
    if (announce || wasOffline) notice('Havuz hazır. Modelinizi seçip bir görev başlatabilirsiniz.');
  } catch (error) { $('connection-state').textContent = 'Bağlantı yok'; notice(error.message, true); }
  finally { refreshing = false; }
}
function settingField(label, value, update, choices) {
  const wrapper = element('label', null, 'setting-field'); wrapper.append(element('span', label));
  const input = choices ? document.createElement('select') : document.createElement('input');
  if (choices) input.replaceChildren(...choices.map(choice => new Option(Array.isArray(choice) ? choice[1] : (choice || 'CLI varsayılanı'), Array.isArray(choice) ? choice[0] : choice)));
  else input.maxLength = 100;
  input.value = value;
  input.addEventListener('change', () => update(input.value)); wrapper.append(input); return wrapper;
}
function renderSettings() {
  $('workspace-roots').value = settings.config.workspaceRoots.join('\n');
  const previousAdapter = $('new-adapter').value;
  const adapters = snapshot.installed.filter(cli => cli.status === 'installed');
  $('new-adapter').replaceChildren(new Option('CLI seçin', ''), ...adapters.map(cli => new Option(cli.adapter, cli.adapter)));
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
        settings = await call('settings'); renderSettings(); await refresh();
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
    for (const model of route.models) {
      const row = element('div', null, 'model-settings'); row.append(element('span', model.id, 'model-id'));
      const modelLabel = element('label', null, 'route-header'); const modelEnabled = document.createElement('input'); modelEnabled.type = 'checkbox'; modelEnabled.checked = model.enabled !== false;
      modelEnabled.addEventListener('change', () => { model.enabled = modelEnabled.checked; }); modelLabel.append(modelEnabled, element('span', 'Model etkin')); row.append(modelLabel);
      row.append(settingField('Görünen ad', model.alias, value => { model.alias = value; }), settingField('Grup', model.group, value => { model.group = value; }), settingField('Varsayılan efor', model.defaultEffort || '', value => { if (value) model.defaultEffort = value; else delete model.defaultEffort; }, ['', ...model.efforts]));
      section.append(row);
    }
    const addModelRow = element('div', null, 'actions');
    const newModelInput = document.createElement('input'); newModelInput.placeholder = 'Bu bağlantıya yeni model kimliği ekle';
    const addModelBtn = button('Model ekle', async () => {
      const id = newModelInput.value.trim();
      if (!id) throw new Error('Model kimliği girin.');
      if (route.models.some(m => m.id === id)) throw new Error('Bu model zaten ekli.');
      const kinds = route.adapter === 'mmx' ? ['text'] : route.adapter === 'qwen' ? ['text', 'read'] : ['text', 'read', 'write'];
      route.models.push({ id, alias: id, group: route.billing === 'free' ? 'free' : 'unassigned', enabled: true, efforts: [], kinds });
      newModelInput.value = ''; renderSettings();
    });
    addModelRow.append(newModelInput, addModelBtn); section.append(addModelRow);
    const routeActions = element('div', null, 'actions');
    routeActions.append(button('Plan / kota durumunu sorgula', async () => { const q = await call('quota', { routeId: route.id }); await refresh(); showDetail(q); }));
    if (['codex', 'opencode'].includes(route.adapter) && !route.api) {
      routeActions.append(button('Modelleri CLI’dan yenile', async () => {
        const catalog = await call('catalog', { routeId: route.id });
        for (const m of catalog.models) {
          if (!route.models.some(existing => existing.id === m.id)) {
            route.models.push({ id: m.id, alias: m.name, group: m.free ? 'free' : 'unassigned', enabled: true, efforts: m.efforts, kinds: ['text', 'read', 'write'] });
          }
        }
        settings = await call('save', settings); renderSettings(); await refresh();
        notice(`${route.id} model listesi güncellendi.`);
      }));
    }
    section.append(routeActions);
    return section;
  }));
  if (!settings.config.routes.length) $('settings-routes').append(element('p', 'Henüz bağlantı yok. Aşağıdan kurulu bir CLI veya özel API sağlayıcısı ekleyin.', 'empty'));
  if (busy) $('settings-routes').querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = true; });
}
function loginCommandsLabel(adapter) {
  return ({ codex: 'codex login', claude: 'claude auth login', qwen: 'qwen', opencode: 'opencode providers login', mmx: 'mmx auth login' })[adapter] || adapter;
}
$('new-adapter').addEventListener('change', () => {
  const adapter = $('new-adapter').value;
  if (adapter === 'opencode') $('new-billing').value = 'free';
  else if (adapter === 'mmx') $('new-billing').value = 'free_credits';
  else if (adapter === 'claude' || adapter === 'codex') $('new-billing').value = 'subscription';
});
$('task-kind').addEventListener('change', updateModels);
$('refresh').addEventListener('click', () => void refresh(true));
$('close-detail').addEventListener('click', () => { $('detail').hidden = true; $('task-heading').tabIndex = -1; $('task-heading').focus(); });
$('open-settings').addEventListener('click', () => void action(async () => {
  settings = await call('settings'); renderSettings(); $('settings').hidden = false;
  if (!$('task-workspace').value) $('task-workspace').value = settings.config.workspaceRoots[0] || '';
  $('settings-heading').tabIndex = -1; $('settings-heading').focus();
}));
$('close-settings').addEventListener('click', () => { $('settings').hidden = true; $('open-settings').focus(); });
$('save-settings').addEventListener('click', () => void action(async () => { settings = await call('save', settings); renderSettings(); await refresh(); notice('Ayarlar kaydedildi. Yeni görevlerde geçerli.'); }));
$('workspace-roots').addEventListener('input', () => { if (settings) settings.config.workspaceRoots = $('workspace-roots').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); });
$('add-route').addEventListener('click', () => void action(async () => {
  const adapter = $('new-adapter').value;
  const billing = $('new-billing').value;
  const cli = snapshot.installed.find(cli => cli.adapter === adapter && cli.executable);
  if (!cli) throw new Error('Kurulu bir CLI seçin.');
  if (!$('subscription-confirmed').checked) throw new Error('Önce CLI’ın seçtiğiniz ödeme/plan türüyle yapılandırıldığını onaylayın.');
  if (!settings.config.workspaceRoots.length) throw new Error('Önce izin verilen bir çalışma klasörü ekleyin.');
  const modelId = $('new-model').value.trim();
  if (!['codex', 'opencode'].includes(adapter) && !modelId) throw new Error('CLI içinde kullandığınız model kimliğini girin.');
  let id = `${adapter}-local`;
  let suffix = 2;
  while (settings.config.routes.some(route => route.id === id)) id = `${adapter}-local-${suffix++}`;
  const kinds = adapter === 'mmx' ? ['text'] : adapter === 'qwen' ? ['text', 'read'] : ['text', 'read', 'write'];
  const route = { id, adapter, executable: cli.executable, enabled: false, billing, trustedSettings: billing === 'free' && adapter === 'opencode', priority: 100, maxConcurrent: 1, models: modelId ? [{ id: modelId, alias: modelId, group: billing === 'free' ? 'free' : 'unassigned', enabled: true, efforts: [], kinds }] : [] };
  settings.config.routes.push(route);
  settings = await call('save', settings);
  if (['codex', 'opencode'].includes(adapter) && !modelId) {
    const catalog = await call('catalog', { routeId: id });
    settings.config.routes.find(connection => connection.id === id).models = catalog.models.map(model => ({ id: model.id, alias: model.name, group: model.free ? 'free' : 'unassigned', enabled: true, efforts: model.efforts, kinds: ['text', 'read', 'write'] }));
    settings = await call('save', settings);
  }
  $('new-model').value = ''; $('subscription-confirmed').checked = false;
  renderSettings(); await refresh(); notice('CLI bağlantısı eklendi. Modelleri inceleyip bağlantıyı etkinleştirebilirsiniz.');
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
  renderSettings(); await refresh(); notice(`${id} API bağlantısı eklendi ve etkinleştirildi.`);
}));
$('task-form').addEventListener('submit', event => {
  event.preventDefault();
  void action(async () => {
    const model = availableModels().find(candidate => `${candidate.routeId}/${candidate.id}` === $('task-model').value);
    if (!model) throw new Error('Önce etkin bir model seçin.');
    const request = { prompt: $('task-prompt').value, workspace: $('task-workspace').value, kind: $('task-kind').value, routeId: model.routeId, modelId: model.id, timeoutSeconds: 300 };
    const fingerprint = JSON.stringify(request);
    if (submitted?.fingerprint !== fingerprint) submitted = { fingerprint, key: crypto.randomUUID() };
    showDetail(await call('submit', { ...request, idempotencyKey: submitted.key }));
    await refresh(); notice('Görev kaydedildi. Durumunu ve sonucunu görev listesinden takip edebilirsiniz.');
  });
});
void refresh(true);
setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 5000);
