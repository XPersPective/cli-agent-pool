# Ajan bağlantısı ve havuz seçimi

Standart MCP kullanın: `cli-agent-pool stdio` mevcut yerel servise bağlanır ve kapalıysa
başlatır. Sağlayıcı tokenı, hesap kimliği veya yönetim anahtarı istemciye kopyalanmaz.
HTTP taşıması gerekiyorsa adres `http://127.0.0.1:43127/mcp` (Streamable HTTP).

## En kısa görev akışı

1. `pool_list_pools {}`: üç havuz, tam model kimliği, etkinlik, `fixedEffort` ve son kota.
2. `pool_select { "kind": "read", "group": "medium" }`: canlı kota kontrolüyle seçim
   ve alternatifler; görev başlatmaz.
3. `pool_submit`:

```json
{
  "prompt": "Kaynak kodu incele ve bulguları özetle.",
  "workspace": "D:\\repositories\\my-project",
  "kind": "read",
  "group": "medium",
  "idempotencyKey": "review-project-001"
}
```

Seçim adımı isteğe bağlıdır; `pool_submit` aynı kota kontrolünü yapar. Başlatılan
kimlikle `pool_get_task { "taskId": "..." }` çağırın. `modelId`, `group`, `effort`
seçilen politikayı; `reportedModel` varsa CLI'ın bildirdiği çalışan sürümü gösterir.
`reportedModel: null` kimliğin bağımsız olarak bildirilmediğini ifade eder.

Yanıt kaybolursa aynı içerik ve aynı idempotencyKey kullanılır. Yeni bir anahtar,
yeni bir iş demektir. Başlamış/başarısız yazma işini başka modelde körlemesine
tekrarlamayın; `needs_review` kullanıcı incelemesi ister.

## Seçim kuralları

- `pool_get_policy {}` içindeki selectionMode `manual` ise `group` zorunludur ve
  yalnızca `high`, `medium`, `low` kabul edilir. Havuz dışındaki açık model de reddedilir.
- `auto` modunda grup verilmezse uygun katalogdan seçilir. Grup verilirse o havuz
  bağlayıcıdır. Havuz üyeliğinde sabit efor varsa onu değiştirmeyin veya alanı boş bırakın.
- Aynı havuzda kota dolmuş bağlantı atlanır. `routeId` veya `modelId` sabitlerseniz
  havuzun diğer üyelerine otomatik geçişi daraltmış olursunuz.
- Ücretli API otomatik kullanımı yalnızca sahibinin açık `autoSelect` tercihiyle olur.
- Sahibin gizlediği model/aileler listelenmez ve açık model isteğiyle de kullanılamaz. Ajan grup düzenlemesi bu filtreleri kaldıramaz. Giriş gerekiyorsa kullanıcı Modeller veya Ayarlar ekranından resmî CLI girişini tamamlar.
- Kota desteklenmiyorsa `unknown`/boş windows dönebilir; bunu sıfır veya sınırsız saymayın.

## Havuz üyeliği yönetimi

Kullanıcı `groupingMode: agent` açmışsa politika revision'ı ile:

```json
{
  "revision": "pool_get_policy yanıtındaki revision",
  "assignments": [
    { "routeId": "codex-local", "modelId": "katalogdaki-tam-kimlik", "group": "high", "effort": "high" }
  ]
}
```

Bunu `pool_assign_groups` aracına verin. Başka havuzlardaki üyelikler korunur.
`remove: true` yalnızca belirtilen üyeliği çıkarır. Kullanıcının eforunu değiştirmek
için açık talimat olmadıkça mevcut eforu koruyun. Bu araç ödeme, yetki veya seçim
modunu değiştiremez. Revizyon çakışırsa güncel politika ve havuzları yeniden okuyun.

## Hatalar

| Kod | Yapılacak işlem |
| --- | --- |
| POOL_REQUIRED | Manuel modda high / medium / low belirtin. |
| NO_ROUTE | Seçilen havuzun üyelerini, efor kuralını, kotasını ve etkinliğini kontrol edin. |
| GROUPING_DENIED | Üyelik değişikliği kullanıcıya ait; ajan yetkisi kapalı. |
| CONFIG_CONFLICT | Yeni revision ve havuz listesini okuyun; değişikliği yeniden değerlendirin. |
| INVALID_REQUEST | Araç şemasındaki alan/tür/sınırları düzeltin. |
| IDEMPOTENCY_CONFLICT | Aynı anahtarı farklı görev içeriğiyle kullanmayın. |
| INVALID_WORKSPACE | Mevcut bir klasörün mutlak yolunu verin; Pool proje kaydı gerektirmez. |

CLI eşdeğeri:

```text
cli-agent-pool select --kind read --group medium
cli-agent-pool run --kind read --group medium --workspace D:\repositories\my-project --prompt "Kaynak kodu incele"
```
# Editor-neutral JSON transport

`cli-agent-pool rpc` accepts one UTF-8 JSON object on stdin and returns JSON on
stdout, including errors (`error.code`, `error.message`, nonzero exit status).
It starts the shared daemon when needed. Prompts and credentials need not appear
in shell arguments. Only the same 11 agent MCP tools are callable; owner management
operations are unavailable through RPC. Input is bounded at 1 MB; tool/HTTP limits
still apply. Example stdin:

```json
{"tool":"pool_select","arguments":{"kind":"write","group":"medium","minRemainingPercent":10}}
```

`minRemainingPercent` on `pool_select` and `pool_submit` can raise the owner's
minimum quota reserve, never lower it. Unknown quota follows the existing bounded
task policy; it does not establish a numeric reserve guarantee. Fixed owner effort
and manual group boundaries apply equally to MCP and JSON callers.

Project Brain 3.3.0+ uses this transport for discovery, selection and durable task
submission. Brain's planning/evidence/runtime remains a separate skill. Its default
task tiers L/M/H map to Pool's low/medium/high groups. A restart resumes the saved
task ID or exact idempotent request; no failed write is replayed automatically.

## Freebuff and other editors

Run `cli-agent-pool mcp-config` to print a credential-free stdio server entry using
the current installed Node and Pool entry paths. Merge its `cli-agent-pool` entry
into the editor's `mcpServers` object without replacing existing server entries.
Freebuff Desktop/CLI supports `~/.agents/mcp.json`; restart/reload its MCP connection
after configuration. The stdio bridge wakes Pool if stopped and exposes the same
11 tools and owner policy. Native Freebuff trust/permission prompts still apply.

This makes Freebuff a Pool client. The installed Freebuff 0.2.29 CLI exposes neither
headless prompt execution nor exact model/effort selection in `--help`; it is not
advertised as an executable Pool model provider. No private upstream proxy or
credential extraction is used. See the official [MCP loader](https://github.com/CodebuffAI/freebuff/blob/main/sdk/src/agents/load-mcp-config.ts)
and [CLI argument contract](https://github.com/CodebuffAI/freebuff/blob/main/cli/src/cli-args.ts).


## Uygulayan alt ajan protokolü (v1)

Kod değiştirme, komut çalıştırma ve test görevleri için çağıran ajan **varsayılan
olarak** `kind: "write", mode: "execute"` göndermeli. `text` yalnızca yanıt üretir;
`read` inceleme içindir. Çalışma kökü çağıran projenin mevcut mutlak yolu olmalıdır;
Pool kurulum klasörünü proje diye göndermeyin. `pool_list_models.executionModes`
uygun adaptörleri gösterir; mevcut modelin write yeteneği de açık olmalıdır.

```json
{
  "prompt": "İlgili hatayı düzelt, gerekli kontrolleri çalıştır ve kısa rapor ver.",
  "workspace": "D:\\repositories\\my-project",
  "kind": "write",
  "mode": "execute",
  "group": "high",
  "timeoutSeconds": 600,
  "idempotencyKey": "implement-fix-001"
}
```

```text
cli-agent-pool run --kind write --mode execute --group high --workspace D:\repositories\my-project --timeout 600 --wait 3600 --prompt "Hatayı düzelt ve test et"
```

Alt ajana yerel dosya/komut araçlarıyla işi yapması, proje talimatlarını okuması,
ilgisiz değişiklikleri koruması ve en fazla 200 kelimelik rapor vermesi söylenir.
Rapor: sonuç, değişen dosyalar ve amaçları, gerçekten çalıştırılan kontroller ve
başarı/hata, engeller/eksikler. `succeeded` CLI turunun tamamlandığını gösterir;
ana ajan raporu ve gerçek diff/test kanıtını incelemelidir. Model raporu bağımsız
bir dosya doğrulaması değildir. `pool_get_task {taskId, compact: true}` prompt ve
olayları çıkarır, raporu 6000 karakterle sınırlar; kesilirse `reportTruncated: true`
bildirir. Tam çıktı eski biçimde erişilebilir. Execute CLI bekleyişi kısa biçimi kullanır.

Native CLI izinleri aynen işler. Claude execute araçlarına Bash eklenir; ZCode'da
Pool'un Bash araç engeli kaldırılır. Native deny/trust kuralları, Codex workspace
sandbox'ı, route billing, sabit effort ve kota rezervleri atlanmaz. Kota sağlayıcıya
aittir; alt ajan sahte bakiye veya daha düşük rezerv ayarlayamaz. İstek
`minRemainingPercent` ile daha yüksek rezerv isteyebilir. İzin verilmeyen bir
komut yerel CLI'da açıkça yetkilendirilmeli; Pool sessiz bypass yapmaz.

Aynı/örtüşen projede okumalar birlikte çalışır. Yazma ve `needs_review` dışlayıcıdır;
bekleyen yazmanın önüne yeni okuyucular geçemez. Aynı proje üzerinde **paralel
uygulama** için ana ajan ayrı Git worktree'ler hazırlar, her göreve kendi mutlak
worktree yolunu ve sınırlı sorumluluğunu verir. Sonuçları inceledikten sonra tek bir
write/execute entegrasyon göreviyle birleştirir. Pool otomatik merge/commit yapmaz.
Aynı klasörde birden çok yazma görevi sıraya alınır; bu bir başarısızlık değildir.

`--timeout` çalışan CLI'ın süresidir; `--wait` çağıranın kuyruk dahil bekleme bütçesi
(varsayılan 3600, 1–86400 saniye). Bekleme dolarsa mevcut durum, `waitExpired` ve
`resume` çağrısı döner; görev iptal edilmez veya yeniden gönderilmez. İnceleme kilidi
varsa engelleyen görev hemen bildirilir. `--detach` doğrudan görev kimliğini döndürür.
Başarısız/kesilmiş yazmayı yeni anahtarla yeniden başlatmayın; değişiklikleri inceleyin.

### İki mod ve zorunlu rapor biçimi

`mode: "response"` yanıt/analiz modu (`kind: text` veya `read`),
`mode: "execute"` icra modu (`kind: write`). CLI'da `--kind` verilmezse response
text, execute write seçer. Eski mode alanı olmayan çağrılar aynı davranır.
Havuz/model seçimi iki modda da çağıran ajandadır; sabit efor ve owner kuralları korunur.
Execute içinde Codex'in native web araması (`--search`), Claude'un bütün yerleşik
araçları (`--tools default`) açılır. Diğer adaptörler native write araçlarını kullanır.
Native izinler, sağlayıcının araç desteği ve ağ sınırları geçerlidir.

İcra sonucunun son yanıtı **tek JSON** olmalı (tüm alanlar zorunlu; yoksa boş dizi):

```json
{
  "status": "completed",
  "summary": "İstenen hata düzeltildi.",
  "files": [{"path": "src/example.js", "change": "Hatalı koşul düzeltildi"}],
  "checks": [{"command": "npm test", "outcome": "passed"}],
  "research": [{"source": "https://example.org/docs", "finding": "İlgili API doğrulandı"}],
  "blockers": []
}
```

`status`: completed / partial / blocked. `checks.outcome`: passed / failed / not_run.
Rapor en fazla 6000 karakter; modele 200 kelime hedefi verilir. Bütün değişen dosyalar
ve araştırma kaynakları yazılır. Pool biçimi doğrular ve `report` alanında döndürür.
`compact: true` geçerli rapor varsa aynı metni `result` içinde tekrar göndermez.
Eksik/bozuk rapor `INVALID_REPORT`, partial/blocked `WORK_INCOMPLETE` ile needs_review
olur; orijinal yanıt kaybolmaz, görev yeniden çalıştırılmaz. Raporun biçim kontrolü,
içeriğinin gerçek dosyalarla bağımsız karşılaştırıldığı anlamına gelmez.

### Dosya araçlarını istekle seçme (1.8)

Native dosya araçlı Codex, Claude, Qwen, Antigravity, OpenCode/MiMo, ZCode,
MiniMax Code ve Kimi bağlantıları varsayılan `toolPolicy: native` ile çalışır.
Eski katalogdaki `kinds: [text]` kayıtları bu CLI'ları yapay olarak araçsız bırakmaz.
`pool_list_models` etkin `kinds`, eski `configuredKinds`, `toolSupport`, `toolPolicy`
ve `executionModes` alanlarını ayrı döndürür. Yetenek, CLI izin onayı veya her modelin
bu araçları başarıyla kullanacağı garantisi değildir.

- `kind: text, mode: response`: metin yanıtı; CLI adaptörü araçları desteklediği ölçüde kapatır.
- `kind: read, mode: response`: projeyi okuyan analiz; yazma/komutlar native plan/izin politikasıyla sınırlandırılır.
- `kind: write, mode: execute`: dosya/komut araçlarıyla uygulama ve zorunlu kısa JSON raporu.

Qwen yazmada native auto-edit, okumada plan kullanır. Antigravity dosya görevlerinde
native plan/accept-edits modunu ve proje araçlarını kullanır. Native deny/trust
kuralları aşılmaz. Ayarlar > Dosya araçları > yapılandırılmış kapsam seçilirse
`toolPolicy: configured`, modelin kayıtlı kinds sınırını ayrıca uygular.
MMX, Ollama/LM Studio ve OmniRoute sohbet komutları yerel dosya aracı sağlamaz;
bunlara dosya aracı varmış gibi etiket verilmez. Özel CLI şablonu read/write
kapsamını kendi native bayraklarıyla uygulamalıdır; Pool shell veya evrensel dosya
aracı eklemez. Salt okunur kapsam bazı native CLI'larda işletim sistemi sandbox'ı
olmayan plan/tool politikasıdır; ajan çıktıları güvenilir kanıt değildir.
