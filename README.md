# CLI Agent Pool

Yerel AI CLI aboneliklerini, token planlarını, ücretsiz modelleri ve özel API sağlayıcılarını
MCP üzerinden ortak bir görev havuzunda kullanın. Kendi yerel web ekranı ve standart MCP
arayüzü vardır. DeepSeek Harness, Hermes, Project Brain veya Store Automation bağımlılığı yoktur.

**Kapsam:** Bu proje yalnızca yerel model/CLI havuzunu hazır ve kullanılabilir tutar.
Uzaktan erişim (mobil/VPN/tünel) bu projenin kapsamı dışındadır; uzaktan çalışma
ihtiyacı Codex veya Antigravity gibi ana geliştirme araçlarının kendi uzak erişim
özellikleriyle karşılanır. Gemini CLI desteği kaldırılmıştır.

## Gereksinimler

- Node.js 24.7 veya üstü (`node:sqlite` bu sürümde deneysel).
- Python 3.11 veya üstü; ek Python paketi yok.
- En az bir desteklenen AI CLI (`codex`, `claude`, `opencode`, `zcode`, `qwen`, `mcode`, `mmx`, `kimi`, `mimo`, `agy`, `omniroute`, `lmstudio`, `ollama`, `aider`, `kilocode`, `hermes` veya özel `custom` CLI).
- Yönetim ekranı için güncel bir web tarayıcısı; başka bir ajan uygulaması gerekmez.

## Başlangıç ve Otomatik Sistem Taraması (`scan-import`)

```powershell
npm ci --ignore-scripts
node bin/pool.js init
node bin/pool.js discover
node bin/pool.js scan-import
```

`discover` komutu bilgisayarınızdaki `PATH`, global npm paketleri, kullanıcı CLI klasörleri (`~/.zcode`, `~/.minimax-code`, `~/.kimi-code`, `~/.mimocode`, `~/.lmstudio`, `%LOCALAPPDATA%\agy`, `%LOCALAPPDATA%\qwen-code`, `%LOCALAPPDATA%\hermes` vb.) ve masaüstü uygulama dizinlerini (`C:\Program Files\ZCode\resources\glm\zcode.cjs` dahil) otomatik tarar ve her aracın yerel yapılandırmasındaki modelleri (Z.AI GLM Coding Plan, Qwen, OpenCode, Codex, MiniMax Code, Kimi vb.) credential kopyalamadan bulur.

`scan-import` komutu (veya web ekranındaki **"Bilgisayarı tara ve tümünü havuza aktar"** düğmesi) bulunan tüm kurulu CLI'ları ve modellerini tek adımda yerel `config.json` havuzuna aktarır.

`init` yerel veri dizininde `config.json`, `access-token`, `management-token` ve
yaz-salt (write-only) API anahtarları için `secrets/` klasörünü oluşturur.
Windows varsayılanı `%LOCALAPPDATA%\cli-agent-pool`, diğer sistemlerde
`~/.local/share/cli-agent-pool`. `CLI_AGENT_POOL_HOME` ile değiştirilebilir.
**Bu dizini repository, OneDrive veya başka bir senkronizasyon klasörü içine koymayın.**
Token değerlerini sohbete, komut satırı argümanlarına veya Git'e yapıştırmayın.

Yerel `config.json` içinde `workspaceRoots` ve `routes` tanımlayabilir veya doğrudan
web yönetim ekranından bağlantı ekleyebilirsiniz:

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

`refresh-models <route>` komutu tüm adaptörlerde yerel/canlı model kataloğunu yeniler;
OpenCode ve ZCode üzerindeki ücretsiz modelleri (`:free` veya `cost.input === 0`) otomatik
olarak `free` grubuna ayırır. Mevcut manuel gruplar korunur.

## Ödeme / Plan Türleri, Özel API ve Özel CLI Desteği

Her bağlantı (`route`) aşağıdaki `billing` modlarından biriyle tanımlanır:

- `subscription`: Resmî CLI aboneliği (ChatGPT Plus/Pro, `claude.ai` Max/Pro vb.).
- `token_plan`: Sabit kotalı/abonelikli coding veya token planları (ör. Z.AI GLM Coding Plan `zcode`, Qwen/DashScope Coding Plan, MiniMax Token Plan `mcode`/`mmx`, Kimi Coding Plan `kimi`).
- `free_credits`: Günlük veya promosyon kredi tanımlı hesaplar (ör. MiniMax `mmx` günlük kredileri — aktif token plan aboneliği olmasa bile günlük kredilerle kullanılabilir).
- `free`: Ücretsiz modeller (ör. OpenCode ücretsiz modelleri, ZCode `longcat:free`, yerel `lmstudio`/`ollama`).
- `paid_api`: Kullanım başına ücretli API. Varsayılan olarak otomatik model seçimine (`autoSelect: false`) girmez; yalnızca `routeId` açıkça seçildiğinde veya kullanıcı `autoSelect: true` açtığında kullanılır.

### Özel API (Anthropic veya OpenAI Yuvası) ve Özel CLI (`custom`) Ekleme

Web yönetim ekranındaki **"Özel API / Token Planı Ekle"** veya **"Özel CLI aracı ekle"** formundan:

1. **Anthropic Uyumlu (`api.protocol: "anthropic"`)**: Claude Code CLI üzerinden `ANTHROPIC_BASE_URL` ve `ANTHROPIC_AUTH_TOKEN` izole alt süreç ortamına enjekte edilir.
2. **OpenAI Uyumlu (`api.protocol: "openai"`)**: OpenCode CLI üzerinden `OPENCODE_CONFIG_CONTENT` ile özel sağlayıcı (`@ai-sdk/openai-compatible`) ve görev bazlı salt-okunur/yazma izinleri enjekte edilir.
3. **Özel CLI (`adapter: "custom"`)**: Listede olmayan herhangi bir CLI aracını `argsTemplate` yer tutucularıyla (`{model}`, `{effort}`, `{workspace}`, `{prompt}`, `{kind}`) shell kullanmadan havuza ekleyebilirsiniz.

API anahtarları `config.json` içine yazılmaz; yerel veri dizinindeki `secrets/<secretRef>.key`
dosyasında saklanır ve tarayıcıya veya MCP istemcilerine hiçbir zaman geri döndürülmez.

## Sağlayıcı Kapsamı ve CLI Giriş Yönlendirmesi

| Adaptör | Desteklenen Plan / Modlar | Otomatik Keşif / Kota | CLI Giriş Komutu |
|---|---|---|---|
| **Codex** (`codex`) | `subscription` | Canlı model/efor keşfi (`~/.codex/models_cache.json` + `codex app-server`) | `codex login` |
| **Claude Code** (`claude`) | `subscription`, `token_plan`, `paid_api` | `claude auth status` + `cclimits` kota takibi | `claude auth login` |
| **OpenCode** (`opencode`) | `free`, `token_plan`, `subscription`, `paid_api` | `opencode models --verbose` ve `~/.config/opencode/opencode.json` keşfi | `opencode providers login` |
| **ZCode / Z.AI** (`zcode`) | `token_plan` (GLM Coding Plan), `free`, `subscription` | `~/.zcode/v2/config.json` model keşfi (`GLM-5.3`, `GLM-5.2` vb.) + `cclimits` Z.AI kotası | `zcode` |
| **Qwen CLI** (`qwen`) | `token_plan`, `subscription`, `free` | `~/.qwen/settings.json` model keşfi (`qwen3.8-max`, `deepseek-v4` vb.) | `qwen` |
| **MiniMax Code** (`mcode`) | `token_plan`, `free_credits`, `subscription` | `~/.minimax/config.yaml` (`MiniMax-M3`, `MiniMax-M2.7`) keşfi | `mcode` |
| **MiniMax CLI** (`mmx`) | `free_credits` (günlük kredi), `token_plan`, `subscription` | `mmx quota show` ve `mmx auth status` ile plan/kredi durumu | `mmx auth login` |
| **Kimi Code** (`kimi`) | `token_plan`, `subscription` | `~/.kimi-code/config.toml` (`kimi-code/k3-256k`) + `cclimits` kotası | `kimi login` |
| **Xiaomi MiMo** (`mimo`) | `token_plan`, `subscription` | `~/.mimocode` CLI keşfi (`mimo-v2-pro`) | `mimo` |
| **Antigravity** (`agy`) | `subscription` | `%LOCALAPPDATA%\agy\bin\agy.cmd` + `cclimits` Gemini/AGY kotası | `agy` |
| **OmniRoute** (`omniroute`) | `token_plan`, `free` | Yerel OmniRoute yönlendirici keşfi | `omniroute` |
| **LM Studio / Ollama** (`lmstudio`, `ollama`) | `free` (yerel) | `lms ls --json` ve `~/.ollama/models` yerel model keşfi | `lms status` / `ollama list` |
| **Aider / Kilo / Hermes / Custom** (`aider`, `kilocode`, `hermes`, `custom`) | `subscription`, `token_plan`, `free` | Otomatik ikili keşfi ve şablon tabanlı (`argsTemplate`) güvenli yürütme | İlgili CLI komutu |

Yönetim ekranındaki **Kota, Plan ve Kredi Durumu** bölümü her bağlantının plan türünü,
varsa kalan kota yüzdesini, API protokol yuvasını ve giriş yapılması gerektiğinde
çalıştırılacak CLI komutunu gösterir.

## MCP Bağlantısı

Endpoint: `http://127.0.0.1:43127/mcp`, taşıma: **Streamable HTTP**.
Kodlama araçları için en kolay yol, yerel erişim anahtarını kendisi okuyan **stdio bağlantısıdır**:

```powershell
codex mcp add cli-agent-pool -- node D:\repositories\cli-agent-pool\bin\pool.js stdio
```

Diğer MCP istemcilerinde komut `node`, argümanlar
`["D:/repositories/cli-agent-pool/bin/pool.js", "stdio"]` olur.
Bu bağlantı yeni bir havuz oluşturmaz; çalışan tek HTTP servisine bağlanır.
Havuzu `serve` ile önce başlatın. İstemci yapılandırmasına sağlayıcı anahtarı,
abonelik tokenı veya Pool erişim anahtarı yazılması gerekmez.

Araçlar: `pool_list_connections`, `pool_list_models`, `pool_get_policy`,
`pool_select`, `pool_submit`, `pool_get_task`, `pool_list_tasks`,
`pool_cancel_task`, `pool_get_quotas`.

`pool_submit` için `prompt`, `workspace`, `kind` (`text`, `read`, `write`) ve
`idempotencyKey` gerekir. İsteğe bağlı `routeId`, `modelId`, `group`, `effort`,
`timeoutSeconds` alanları vardır. Otomatik seçimde abonelik, token planı, günlük kredi
ve ücretsiz modeller her zaman `paid_api` bağlantıların önünde yer alır.

## Bağımsız Yönetim Ekranı

`serve` komutu bir MCP adresi ve ayrı bir `dashboard` bağlantısı yazdırır.
Dashboard bağlantısı tek kullanımlıktır; açıldıktan sonra adres temizlenir ve
8 saatlik, HttpOnly / SameSite=Strict oturum çerezi kullanılır. Tarayıcıya sağlayıcı
credential'ı, API anahtarı veya kalıcı MCP/yönetim anahtarı verilmez.

Ekranda kurulu CLI'lar, CLI bağlantısı ekleme, Özel API / Token Planı ekleme (Anthropic
veya OpenAI yuvası), izinli klasörler, manuel model grupları, ücretsiz model/plan rozetleri,
model/efor seçimi, görev başlatma, iptal, geçmiş ve kota/giriş durumu bulunur.

## Güvenli Çalışma

- Yalnızca yerel `127.0.0.1` loopback bağlantısı; yabancı Origin ve Host başlıkları reddedilir.
- Agent token'ı `/manage` yönetim arayüzünü kullanamaz ve API anahtarlarını okuyamaz.
- Subprocess oluşturma shell kullanmaz; prompt stdin üzerinden taşınır.
- Python supervisor Windows Job Object veya POSIX process group kullanır.
- Belirsiz yeniden başlatma ve başarısız/kesilen yazma işleri `needs_review` olur;
  elle incelendikten sonra `node bin/pool.js resolve <task-id>` ile temizlenir.
- Otomatik tekrar ve yürütme başladıktan sonra otomatik fallback yoktur.

## Kontroller

```powershell
npm test
npm run check
npm run secrets
npm audit --audit-level=moderate
git config core.hooksPath .githooks
```

Mimari ve kabul sınırları: [docs/architecture.md](docs/architecture.md).
Gizlilik ve güvenlik: [SECURITY.md](SECURITY.md).
