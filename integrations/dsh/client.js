window.__ModuleLoader__.load({ id: 'cli-agent-pool', factory: require => {
  const React = require('react');
  const h = React.createElement;
  const { useEffect, useState, useRef } = React;
  const states = { queued: 'Sırada', starting: 'Başlatılıyor', running: 'Çalışıyor', succeeded: 'Tamamlandı', failed: 'Başarısız', timed_out: 'Süre doldu', cancelling: 'Durduruluyor', cancelled: 'Durduruldu', needs_review: 'Elle inceleme gerekli' };
  const button = (text, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled }, text);
  function Panel({ rpc }) {
    const [data, setData] = useState(null);
    const [settings, setSettings] = useState(null);
    const [message, setMessage] = useState('Havuza bağlanılıyor…');
    const [busy, setBusy] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [workspace, setWorkspace] = useState('');
    const [route, setRoute] = useState('');
    const [kind, setKind] = useState('read');
    const [selected, setSelected] = useState(null);
    const submitted = useRef(null);
    const mounted = useRef(true);
    const polling = useRef(false);
    async function call(endpoint, payload = {}) {
      const result = await rpc.call('/api', `cli-agent-pool.${endpoint}`, payload);
      if (!result.ok) throw new Error(result.error?.message || 'İşlem tamamlanamadı. Yeniden deneyin.');
      return result.value;
    }
    async function refresh() {
      if (polling.current) return;
      polling.current = true;
      try { const value = await call('snapshot'); if (mounted.current) { setData(value); setMessage('Yerel havuza bağlı.'); } }
      catch { if (mounted.current) setMessage('Havuza ulaşılamıyor. Servisi başlatın; girdiğiniz görev korunuyor.'); }
      finally { polling.current = false; }
    }
    useEffect(() => { mounted.current = true; void refresh(); const timer = setInterval(refresh, 5000); return () => { mounted.current = false; clearInterval(timer); }; }, []);
    async function action(operation) {
      if (busy) return;
      setBusy(true);
      try { await operation(); }
      catch (error) { setMessage(error.message || 'İşlem tamamlanamadı. Tekrar deneyin.'); }
      finally { setBusy(false); }
    }
    const field = (label, element) => h('label', { className: 'pool-field' }, h('span', null, label), element);
    const models = (data?.models || []).filter(model => model.enabled && model.kinds.includes(kind));
    async function submit(event) {
      event.preventDefault();
      await action(async () => {
        const model = models.find(model => `${model.routeId}/${model.id}` === route);
        if (!model) { setMessage('Önce etkin bir model seçin.'); return; }
        const request = { prompt, workspace, kind, routeId: model.routeId, modelId: model.id, timeoutSeconds: 300 };
        const fingerprint = JSON.stringify(request);
        if (submitted.current?.fingerprint !== fingerprint) submitted.current = { fingerprint, key: crypto.randomUUID() };
        const task = await call('submit', { ...request, idempotencyKey: submitted.current.key });
        setSelected(task); setMessage('Görev kaydedildi. İlerlemeyi görev listesinden izleyebilirsiniz.');
        await refresh();
      });
    }
    async function save() {
      await action(async () => {
        const value = await call('save', settings);
        setSettings(value); await refresh(); setMessage('Ayarlar kaydedildi. Yeni görevlerde geçerli.');
      });
    }
    const updateConfig = change => setSettings(previous => { const copy = structuredClone(previous); change(copy.config); return copy; });
    return h('section', { className: 'pool-panel', 'aria-label': 'CLI Ajan Havuzu' },
      h('style', null, `.pool-panel{--pool-gap:16px;--pool-border:var(--border-color,#8886);display:grid;gap:var(--pool-gap);color:inherit;font:inherit;max-width:960px}.pool-panel *{box-sizing:border-box}.pool-panel h2,.pool-panel h3,.pool-panel p{margin:0}.pool-panel button,.pool-panel input,.pool-panel select,.pool-panel textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--pool-border);border-radius:6px;padding:10px;min-height:44px;max-width:100%}.pool-panel button{cursor:pointer}.pool-panel button:disabled{opacity:.55;cursor:wait}.pool-panel :focus-visible{outline:3px solid var(--accent-color,#3186e5);outline-offset:3px}.pool-field{display:grid;gap:6px;min-width:0}.pool-card,.pool-panel form{border:1px solid var(--pool-border);padding:16px;border-radius:10px;display:grid;gap:12px;min-width:0}.pool-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.pool-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:450px;overflow:auto;margin:0}.pool-panel textarea{min-height:120px;width:100%}.pool-panel ul{margin:0;padding-left:20px}.pool-panel small{overflow-wrap:anywhere}.pool-panel [role=status]{min-height:24px}.pool-model{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px}.pool-panel input[type=checkbox]{width:24px;min-height:24px}.pool-toggle{display:flex;align-items:center;gap:10px;min-height:44px}`),
      h('div', { className: 'pool-row' }, h('h2', null, 'CLI Ajan Havuzu'), button('Yenile', () => void refresh(), busy)),
      h('p', { role: 'status', 'aria-live': 'polite' }, message),
      h('div', { className: 'pool-card' }, h('h3', null, 'Bağlantılar'),
        data ? h('ul', null, data.installed.map(cli => h('li', { key: cli.adapter }, `${cli.adapter}: ${cli.status === 'installed' ? 'Kurulu' : 'Bulunamadı'}`))) : h('p', null, 'Bağlantılar bekleniyor.'),
        button('Modeller ve gruplar', () => void action(async () => { setSettings(await call('settings')); }), busy)),
      settings && h('div', { className: 'pool-card' }, h('h3', null, 'Modeller ve gruplar'),
        h('p', null, 'Gruplar size aittir. Efor model gücünden bağımsızdır. Bağlantıyı kapatmak çalışan görevi durdurmaz.'),
        settings.config.routes.map((connection, ri) => h('div', { className: 'pool-card', key: connection.id },
          h('label', { className: 'pool-toggle' }, h('input', { type: 'checkbox', checked: connection.enabled, disabled: busy || connection.billing !== 'subscription', onChange: e => updateConfig(c => { c.routes[ri].enabled = e.target.checked; }) }), `${connection.id} — ${connection.adapter}`),
          field('Öncelik (küçük değer önce)', h('input', { type: 'number', min: 0, max: 1000, value: connection.priority, disabled: busy, onChange: e => updateConfig(c => { c.routes[ri].priority = Number(e.target.value); }) })),
          connection.models.map((model, mi) => h('div', { className: 'pool-model', key: model.id },
            field(model.id + ' — görünen ad', h('input', { value: model.alias, disabled: busy, maxLength: 100, onChange: e => updateConfig(c => { c.routes[ri].models[mi].alias = e.target.value; }) })),
            field('Grup', h('input', { value: model.group, disabled: busy, maxLength: 100, onChange: e => updateConfig(c => { c.routes[ri].models[mi].group = e.target.value; }) })),
            field('Varsayılan efor', h('select', { value: model.defaultEffort || '', disabled: busy, onChange: e => updateConfig(c => { if (e.target.value) c.routes[ri].models[mi].defaultEffort = e.target.value; else delete c.routes[ri].models[mi].defaultEffort; }) }, h('option', { value: '' }, 'CLI varsayılanı'), model.efforts.map(effort => h('option', { value: effort, key: effort }, effort))))
          )),
          button('Kotayı sorgula', () => void action(async () => { setSelected(await call('quota', { routeId: connection.id })); }), busy)
        )),
        h('div', { className: 'pool-row' }, button('Ayarları kaydet', () => void save(), busy), button('Kapat', () => setSettings(null), busy))),
      h('form', { onSubmit: submit }, h('h3', null, 'Görev başlat'),
        field('Görev türü', h('select', { value: kind, disabled: busy, onChange: e => { setKind(e.target.value); setRoute(''); } }, h('option', { value: 'read' }, 'Kod incele / oku'), h('option', { value: 'text' }, 'Metin üret'), h('option', { value: 'write' }, 'Dosya değiştir'))),
        field('Model', h('select', { required: true, value: route, disabled: busy, onChange: e => setRoute(e.target.value) }, h('option', { value: '' }, 'Model seçin'), models.map(model => h('option', { key: `${model.routeId}/${model.id}`, value: `${model.routeId}/${model.id}` }, `${model.alias} · ${model.group} · ${model.routeId}`)))),
        models.length === 0 && h('p', null, 'Bu görev için etkin model yok. Yerel bağlantıları tanımlayın ve Modeller ve gruplar bölümünden etkinleştirin.'),
        field('İzinli çalışma klasörü', h('input', { required: true, value: workspace, disabled: busy, onChange: e => setWorkspace(e.target.value), placeholder: 'Yerel ayarlarda izin verdiğiniz klasör' })),
        field('Görev tanımı', h('textarea', { required: true, value: prompt, maxLength: 100000, disabled: busy, onChange: e => setPrompt(e.target.value) })),
        kind === 'write' && h('p', null, 'Bu görev dosya değiştirebilir. Kesilen yazma görevinden sonra klasör elle incelenmelidir.'),
        h('button', { type: 'submit', disabled: busy || models.length === 0 }, busy ? 'İşlem sürüyor…' : 'Görevi gönder')),
      h('div', { className: 'pool-card' }, h('h3', null, 'Son görevler'),
        data?.tasks.length ? data.tasks.map(task => h('div', { className: 'pool-row', key: task.id },
          h('span', null, `${task.modelId} · ${states[task.state] || task.state}`),
          button('Sonucu görüntüle', () => void action(async () => { setSelected(await call('task', { taskId: task.id })); }), busy),
          ['queued', 'starting', 'running'].includes(task.state) && button('Durdur', () => void action(async () => { setSelected(await call('cancel', { taskId: task.id })); await refresh(); }), busy)
        )) : h('p', null, 'Henüz görev yok. İlk görevinizi yukarıdan başlatın.')),
      selected && h('div', { className: 'pool-card' }, h('h3', null, 'Görev / kota ayrıntısı'), h('pre', { tabIndex: 0 }, selected.result || JSON.stringify(selected, null, 2)), button('Ayrıntıyı kapat', () => setSelected(null)))
    );
  }
  return {
    inject: ['slots', 'connection'],
    apply(ctx) {
      const connection = ctx.get('connection');
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'cli-agent-pool', order: 91, label: () => 'CLI Ajan Havuzu', inject: () => ({ rpc: connection.rpc }) }, Panel));
    },
  };
} });
