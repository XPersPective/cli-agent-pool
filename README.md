# CLI Agent Pool

Yerel AI CLI aboneliklerini MCP üzerinden ortak bir görev havuzunda kullanın.
DSH yönetim panelidir; Project Brain ve Store Automation bağımlılığı yoktur.

**Durum: geliştirme sürümü; üretim kabulü tamamlanmadı.** Gerçek Codex aboneliğiyle
MCP → havuz → CLI → sonuç akışı doğrulandı. Diğer sağlayıcılar ve DSH tarayıcı
akışı ayrı doğrulama gerektirir; desteklenmeyen kota hiçbir zaman tahmin edilmez.

## Gereksinimler

- Node.js 24.7 veya üstü (`node:sqlite` bu sürümde deneysel).
- Python 3.11 veya üstü; ek Python paketi yok.
- En az bir resmî AI CLI ve o CLI içinde kullanıcı tarafından tamamlanmış giriş.
- DSH paneli için DeepSeek Harness 0.2.0-rc.2 hedeflenmiştir.

## Başlangıç

```powershell
npm ci --ignore-scripts
node bin/pool.js init
node bin/pool.js discover
```

`init` yerel veri dizininde `config.json`, `access-token` ve `management-token`
oluşturur. Windows varsayılanı `%LOCALAPPDATA%\cli-agent-pool`, diğer sistemlerde
`~/.local/share/cli-agent-pool`. `CLI_AGENT_POOL_HOME` ile değiştirilebilir.
**Bu dizini repository, OneDrive veya başka bir senkronizasyon klasörü içine koymayın.**
Token değerlerini sohbete, komut satırı argümanlarına veya Git'e yapıştırmayın.

Yerel `config.json` içinde `workspaceRoots` ve `routes` tanımlayın. Aşağıdaki
örnek bir şemadır; çalıştırılabilir dosya ve model kimliğini kendi keşif sonucunuzdan alın:

```json
{
  "port": 43127,
  "python": "python",
  "workspaceRoots": ["D:\\repositories\\your-project"],
  "concurrency": 1,
  "routes": [{
    "id": "codex-local",
    "adapter": "codex",
    "executable": "C:\\path\\to\\codex.js",
    "enabled": false,
    "billing": "subscription",
    "models": []
  }]
}
```

```powershell
node bin/pool.js refresh-models codex-local
node bin/pool.js validate
node bin/pool.js serve
```

Model keşfi mevcut manuel grupları korur; yeni modeller `unassigned` grubundadır.
CLI üzerinden katalog güncellemesinden sonra çalışan havuzu yeniden başlatın.
Bağlantı ilk tanımlandığında kapalı kalır; model/eforları inceleyip panelden veya
yerel ayardan etkinleştirin. Agent MCP araçları güvenlik politikasını değiştiremez.

## MCP bağlantısı

Endpoint: `http://127.0.0.1:43127/mcp`, taşıma: **Streamable HTTP**.
İstemci `Authorization: Bearer ...` başlığını yerel `access-token` dosyasından
güvenli şekilde sağlamalıdır. Anahtarı repository'deki MCP config dosyasına yazmayın.

Araçlar: `pool_list_connections`, `pool_list_models`, `pool_get_policy`,
`pool_select`, `pool_submit`, `pool_get_task`, `pool_list_tasks`,
`pool_cancel_task`, `pool_get_quotas`.

`pool_submit` için `prompt`, `workspace`, `kind` (`text`, `read`, `write`) ve
`idempotencyKey` gerekir. İsteğe bağlı `routeId`, `modelId`, `group`, `effort`,
`timeoutSeconds` alanları vardır. Aynı isteği tekrar gönderirken aynı anahtarı kullanın.
Farklı içerikle aynı anahtar `IDEMPOTENCY_CONFLICT` üretir.
Gönderim HTTP bağlantısı kapansa da kabul edilmiş görev çalışmaya devam eder.

## DSH paneli

Bu paket DSH host eklentisini ve derleme gerektirmeyen tarayıcı factory'sini içerir:

```powershell
dsh plugin --profile web add D:\repositories\cli-agent-pool -w
dsh web --no-open
```

Havuz ayrıca çalışmalıdır. DSH **Ayarlar → CLI Ajan Havuzu** paneli; kurulum
durumunu, manuel grupları, varsayılan eforu, bağlantı önceliğini, görev başlatmayı,
iptali, geçmişi ve desteklenen kotayı sunar. İlk bağlantı/model ekleme yerel
config ve `refresh-models` komutuyla yapılır.
Panel, DSH'nin mevcut kimlik doğrulaması üzerinden konuşur. Pool erişim ve yönetim
anahtarları DSH host'unda kalır; tarayıcıya veya telefona gönderilmez.

## Sağlayıcı kapsamı

| Adaptör | Mevcut kapsam | Sınır |
|---|---|---|
| Codex | ChatGPT giriş kontrolü, görev, canlı model/efor keşfi, kota | Gerçek uçtan uca kontrol yapıldı; user config devre dışı, native sandbox açık |
| Claude | Headless JSONL, resmî CLI auth kontrolü, native izin modu | Yerel ayar/hook güveni `trustedSettings` ile ayrıca onaylanmalı; canlı görev doğrulanmadı |
| Gemini / Qwen | Headless JSONL, plan modu | Deneysel; yazma kapalı, abonelik ayarları kullanıcı tarafından doğrulanmalı |
| MiniMax mmx | Metin ve resmî kota komutu | Tam coding ajanı değildir; canlı plan doğrulaması yapılmadı |

`billing: subscription` bir kullanıcı beyanıdır; Codex ve Claude ek CLI auth
kontrolü yapar. Diğer adaptörlerde `trustedSettings: true` yalnızca sağlayıcı
endpoint'i ve abonelik türü gerçekten kontrol edildikten sonra kullanılmalıdır.
Pool ücretli API fallback'i yapmaz. Bir CLI'ın kendi hesabındaki ek kullanım
ayarlarını evrensel olarak kapatabildiğini iddia etmez.

## Güvenli çalışma

- Varsayılan bağlantı yalnızca `127.0.0.1`; browser Origin ve yabancı Host reddedilir.
- Agent token'ı `/manage` yönetim arayüzünü kullanamaz.
- Görev sayısı, istek/çıktı boyutu, paralellik ve süre sınırları vardır.
- Aynı veya iç içe workspace'ler seri çalışır. Worktree/sandbox otomatik yaratılmaz.
- Subprocess oluşturma shell kullanmaz; prompt stdin üzerinden taşınır.
- Python supervisor Windows Job Object veya POSIX process group kullanır.
- Belirsiz yeniden başlatma ve başarısız/kesilen yazma işleri `needs_review` olur.
- Bu klasör, dosyalar ve kalan süreçler elle incelendikten sonra havuzu durdurup
  `node bin/pool.js resolve <task-id>` kullanın. Bu komut değişiklikleri geri almaz.
- Native CLI izinleri korunur. Workspace doğrulaması bir OS sandbox'ı değildir;
  CLI hook'ları ve yerel kullanıcı yetkileri ayrıca güven sınırıdır.
- Otomatik tekrar ve yürütme başladıktan sonra otomatik fallback yoktur.
  Taze kota snapshot'ı limitli bağlantıyı seçimden çıkarır; bilinmeyen kota sayıya çevrilmez.

Android için DSH web ekranı özel ağ/VPN üzerinden kullanılabilir. Public tunnel,
port yönlendirmesi, Tailscale veya WireGuard kurulumu otomatik yapılmaz; gerçek
Android/VPN erişimi henüz kabul edilmemiştir. Pool portunu internete açmayın.

## Kontroller

```powershell
npm test
npm run check
npm run secrets
npm audit --audit-level=moderate
git config core.hooksPath .githooks
```

Normal testler API çağırmaz; sahte CLI ile gerçek süreç, SQLite ve MCP sınırlarını
çalıştırır. Açıkça istenen canlı test abonelik kotası tüketir:

```powershell
node scripts/smoke.js --live YOUR_AVAILABLE_CODEX_MODEL
```

Windows ve Ubuntu için GitHub Actions tanımlıdır. Bir iş akışının tanımlanması,
uzak CI'ın geçtiği veya ürünün üretime hazır olduğu anlamına gelmez.

Mimari ve kabul sınırları: [docs/architecture.md](docs/architecture.md).
Gizlilik ve güvenlik: [SECURITY.md](SECURITY.md).
