const $ = id => document.getElementById(id);
const labels = { queued: 'Sırada', starting: 'Başlatılıyor', running: 'Çalışıyor', succeeded: 'Tamamlandı', failed: 'Başarısız', timed_out: 'Süre doldu', cancelling: 'Durduruluyor', cancelled: 'Durduruldu', needs_review: 'Elle inceleme gerekli' };
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
function availableModels() { return (snapshot?.models || []).filter(model => model.enabled && model.billing === 'subscription' && model.kinds.includes($('task-kind').value)); }
function updateModels() {
  const previous = $('task-model').value;
  const models = availableModels();
  const signature = JSON.stringify(models);
  if (signature !== modelSignature) {
    modelSignature = signature;
    $('task-model').replaceChildren(new Option('Model seçin', ''), ...models.map(model => new Option(`${model.alias} · ${model.group} · ${model.routeId}`, `${model.routeId}/${model.id}`)));
    if (models.some(model => `${model.routeId}/${model.id}` === previous)) $('task-model').value = previous;
  }
  $('submit').disabled = busy || !models.length;
  $('model-empty').textContent = models.length ? 'Gruplar ve eforlar sizin ayarlarınızdan gelir.' : 'Bu görev için etkin model yok. Modeller ve gruplar bölümünden bağlantıyı etkinleştirin.';
  $('write-warning').hidden = $('task-kind').value !== 'write';
}
function showDetail(value) { $('detail-content').textContent = value.result || JSON.stringify(value, null, 2); $('detail').hidden = false; $('detail-heading').tabIndex = -1; $('detail-heading').focus(); }
function button(text, operation) { const node = element('button', text); node.type = 'button'; node.addEventListener('click', () => void action(operation)); return node; }
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
    $('providers').replaceChildren(...snapshot.installed.map(cli => {
      const row = element('div', null, 'provider');
      const info = element('div'); info.append(element('strong', cli.adapter));
      const configured = snapshot.connections.filter(route => route.adapter === cli.adapter);
      info.append(element('small', configured.length ? `${configured.filter(route => route.enabled).length} etkin bağlantı` : 'Henüz bağlantı tanımlanmadı'));
      row.append(info, element('span', cli.status === 'installed' ? 'Kurulu' : 'Bulunamadı', 'provider-state')); return row;
    }));
    const focusedId = document.activeElement?.id;
    $('tasks').replaceChildren(...(snapshot.tasks.length ? snapshot.tasks.map(task => {
      const row = element('div', null, 'task');
      const title = element('div', null, 'task-title'); title.append(element('strong', task.modelId), element('span', labels[task.state] || task.state, 'badge subtle'));
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
  if (choices) input.replaceChildren(...choices.map(choice => new Option(choice || 'CLI varsayılanı', choice)));
  else input.maxLength = 100;
  input.value = value;
  input.addEventListener('change', () => update(input.value)); wrapper.append(input); return wrapper;
}
function renderSettings() {
  $('workspace-roots').value = settings.config.workspaceRoots.join('\n');
  const previousAdapter = $('new-adapter').value;
  const adapters = snapshot.installed.filter(cli => cli.status === 'installed' && !settings.config.routes.some(route => route.adapter === cli.adapter));
  $('new-adapter').replaceChildren(new Option('CLI seçin', ''), ...adapters.map(cli => new Option(cli.adapter, cli.adapter)));
  if (adapters.some(cli => cli.adapter === previousAdapter)) $('new-adapter').value = previousAdapter;
  $('settings-routes').replaceChildren(...settings.config.routes.map(route => {
    const section = element('div', null, 'route-settings');
    const header = element('label', null, 'route-header'); const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.checked = route.enabled; enabled.disabled = route.billing !== 'subscription';
    enabled.dataset.locked = String(route.billing !== 'subscription');
    enabled.addEventListener('change', () => { route.enabled = enabled.checked; });
    header.append(enabled, element('strong', `${route.id} · ${route.adapter}`)); section.append(header);
    if (route.adapter !== 'codex') {
      const trustedLabel = element('label', null, 'route-header'); const trusted = document.createElement('input');
      trusted.type = 'checkbox'; trusted.checked = route.trustedSettings;
      trusted.addEventListener('change', () => { route.trustedSettings = trusted.checked; });
      trustedLabel.append(trusted, element('span', 'CLI’ın yerel ayarlarını ve hook’larını inceledim.')); section.append(trustedLabel);
    }
    section.append(settingField('Öncelik (küçük değer önce)', route.priority, value => { route.priority = Number(value); }));
    for (const model of route.models) {
      const row = element('div', null, 'model-settings'); row.append(element('span', model.id, 'model-id'));
      const modelLabel = element('label', null, 'route-header'); const modelEnabled = document.createElement('input'); modelEnabled.type = 'checkbox'; modelEnabled.checked = model.enabled !== false;
      modelEnabled.addEventListener('change', () => { model.enabled = modelEnabled.checked; }); modelLabel.append(modelEnabled, element('span', 'Model etkin')); row.append(modelLabel);
      row.append(settingField('Görünen ad', model.alias, value => { model.alias = value; }), settingField('Grup', model.group, value => { model.group = value; }), settingField('Varsayılan efor', model.defaultEffort || '', value => { if (value) model.defaultEffort = value; else delete model.defaultEffort; }, ['', ...model.efforts]));
      section.append(row);
    }
    section.append(button('Kotayı sorgula', async () => showDetail(await call('quota', { routeId: route.id }))));
    return section;
  }));
  if (!settings.config.routes.length) $('settings-routes').append(element('p', 'Henüz bağlantı yok. Terminalde discover ile kurulumları bulun ve yerel config.json içinde ilk bağlantıyı tanımlayın.', 'empty'));
  if (busy) $('settings-routes').querySelectorAll('input,select,textarea,button').forEach(node => { node.disabled = true; });
}
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
  const cli = snapshot.installed.find(cli => cli.adapter === adapter && cli.executable);
  if (!cli) throw new Error('Kurulu bir CLI seçin.');
  if (!$('subscription-confirmed').checked) throw new Error('Önce CLI’ın abonelik yapılandırmasını doğrulayın.');
  if (!settings.config.workspaceRoots.length) throw new Error('Önce izin verilen bir çalışma klasörü ekleyin.');
  const modelId = $('new-model').value.trim();
  if (adapter !== 'codex' && !modelId) throw new Error('CLI içinde kullandığınız model kimliğini girin.');
  const id = `${adapter}-local`;
  if (settings.config.routes.some(route => route.id === id)) throw new Error('Bu bağlantı zaten tanımlı.');
  const route = { id, adapter, executable: cli.executable, enabled: false, billing: 'subscription', trustedSettings: false, priority: 100, maxConcurrent: 1, models: modelId ? [{ id: modelId, alias: modelId, group: 'unassigned', efforts: [], kinds: adapter === 'mmx' ? ['text'] : adapter === 'codex' || adapter === 'claude' ? ['text', 'read', 'write'] : ['text', 'read'] }] : [] };
  settings.config.routes.push(route);
  settings = await call('save', settings);
  if (adapter === 'codex' && !modelId) {
    const catalog = await call('catalog', { routeId: id });
    settings.config.routes.find(connection => connection.id === id).models = catalog.models.map(model => ({ id: model.id, alias: model.name, group: 'unassigned', efforts: model.efforts, kinds: ['text', 'read', 'write'] }));
    settings = await call('save', settings);
  }
  $('new-model').value = ''; $('subscription-confirmed').checked = false;
  renderSettings(); await refresh(); notice('Bağlantı kapalı olarak eklendi. Modelleri ve grupları inceleyip etkinleştirebilirsiniz.');
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
