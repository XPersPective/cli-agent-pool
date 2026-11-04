# Kısa ajan haritası

MCP: cli-agent-pool stdio. CLI ve stdin JSON RPC aynı yerel servisi otomatik açar.
Normal kullanım repository taraması veya politika sorgusu gerektirmez.

| Amaç | Çağrı |
| --- | --- |
| Harita | pool_help {} |
| Kategori adları/sayıları | pool_list_pools {} |
| Bir kategorinin modelleri | pool_list_pools {group:"research"} |
| Katalog kaynakları | pool_catalog {} |
| Ücretsiz katalog | pool_catalog {billing:"free"} |
| Model arama | pool_catalog {query:"flash",kind:"write"} |
| Katalog model sayfası | pool_catalog {view:"models",limit:12,offset:0} |
| Canlı kota/giriş | pool_get_quotas {routeId:"qoder-local"} |
| Hata yardımı | pool_help {code:"AUTH_REQUIRED"} |

Sayfalarda nextOffset varsa sonraki sorgunun offset alanına koyun. Varsayılan
12, en fazla 40 kayıt; boş sorgular bütün modelleri dökmez. Katalog her modeli
tek kez sunar; kategoriler bir modeli farklı varsayılan eforlarla içerebilir.
Her model kaydında exact modelId/routeId, araç kapsamı, efor ve cached kota vardır.
Kota bilinmiyorsa unknown; canlı kontrol ayrı sorgudur.

## Çalıştırma

Bilinen model/kategori için doğrudan pool_submit. group yalnız kategori seçerken
verilir. Katalogdan seçim kategori üyeliği gerektirmez. Seçimi çağıranın talimatı
belirler. Desteklenen bir request.effort kategori varsayılanını geçersiz kılar.

~~~json
{"prompt":"İstenen değişikliği uygula ve kontrol et.","workspace":"D:/projeler/uygulama","kind":"write","mode":"execute","routeId":"qoder-local","modelId":"Qwen3.8-Flash","idempotencyKey":"implement-001"}
~~~

Kategori isteği için routeId/modelId yerine group kullanın. Text/read işleri
kind:text veya read; uygulama/değişiklik kind:write ve mode:execute kullanır.
Sonucu pool_get_task {taskId} ile okuyun: varsayılan compact, prompt/event dump yok.
Ayrıntı gerçekten gerekirse compact:false. report/gerçek dosyaları kontrol edin.
Yanıt kaybında aynı içerik ve anahtarla aynı göreve dönün; started write tekrar edilmez.

~~~sh
cli-agent-pool pools
cli-agent-pool pools --group research
cli-agent-pool catalog --billing free
cli-agent-pool catalog --view models --limit 8
cli-agent-pool run --mode execute --group research --workspace "/project" --prompt "Görevi uygula"
cli-agent-pool help-code --code AUTH_REQUIRED
~~~

RPC stdin biçimi: {"tool":"pool_catalog","arguments":{"billing":"free"}}.
Çağıranın workspace'i mutlak, mevcut yerel dizindir; ayrıca Pool kaydı gerekmez.

## Sorun çıkarsa

Hata kısa error.code/message ve pool_help yönlendirmesi verir. Normal keşifte
hata kılavuzu veya tam görev geçmişi yüklenmez. [Hata başvurusu](errors.md) yalnız
ilgili sorun için okunur. needs_review dosya incelemesi gerektirir; otomatik replay
veya başka modele kör tekrar yok. Kapalı/gizli modeller hiçbir girişten verilmez.
Ücretli API billing, native izinler, model yetenekleri, kota rezervleri ve çalışma
klasörü kilitleri geçerlidir; seçim/gruplama yetki modu yoktur. Kategoriden çıkarma
katalog erişimini kaldırmaz. Kategoriler UI'da oluşturulur, adlandırılır, kaldırılır.

Birden fazla istemci aynı servis/kuyruğu kullanabilir; ayrı projeler paralel,
çakışan yazmalar seri çalışır. Native CLI dosya/komut araçlarını kullanır.
Execute raporu JSON status, summary, files, checks, research, blockers alanlarıyla
maksimum 6000 karakter/tercihen 200 kelimedir. Tam protokol ayrıntısı yalnız gerekirse
paketli skill references/operations.md dosyasında bulunur.

Paralelliği çağıran gönderdiği iş sayısıyla belirler; worker/kuyruk adet tavanı
yoktur. timeoutSeconds iş süresini belirler (varsayılan 300 saniye; bir saat
tavanı yok). Çakışan çalışma klasörlerine yazma ve inceleme kilitleri korunur.

Completed tasks expire after 7 days or the most recent 500 completed tasks. Keep needed reports externally; idempotency keys expire with their records. The UI can clear completed history while preserving active/review tasks.


## Director mechanisms (2.2.0)

`pool_capabilities` discovers `pb-director/1` and optional features. Director
profile, verified preflight, task linking, deadlines, secret environment delivery,
owner review resolution and durable exit hooks are described in
[director design](director-tasks.md) and the packaged skill operations reference.
Relay decisions stay with the caller; Pool has no relay state machine.

`pool_preflight` accepts routeId, modelId, effort, workspace, capabilities,
readPaths, force; returns a cached result or `{id,taskId,state}`. Task retrieval
exposes `preflight` and `parentTaskId`, including compact mode. Status results
carry current, ready, checkedAt, retryAfter, error and capability details.
`pool_preflight_status` reads without a lock/model call. Worker bridges cannot run
preflight/resolve or create director lifecycle hooks; a valid running director
token can submit a preflight-ready successor and acknowledge its own takeover.

Director optional fields are `onExit`, `ackDeadlineSeconds`,
`startDeadlineSeconds`, `idleTimeoutSeconds`, `secretEnv` (PB_ names only).
See the design for limits and restart semantics. The service injects
CLI_AGENT_POOL_TASK_ID/TOKEN/WORKER and strips/redacts secret values before
persistence. Never encode a secret in prompt or hook argv.
