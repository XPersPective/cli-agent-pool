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
- En az bir desteklenen AI CLI (`codex`, `claude`, `opencode`, `qwen`, `mmx`).
- Yönetim ekranı için güncel bir web tarayıcısı; başka bir ajan uygulaması gerekmez.

## Başlangıç

```powershell
npm ci --ignore-scripts
node bin/pool.js init
node bin/pool.js discover
```

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

`refresh-models` komutu hem **Codex** (`codex app-server`) hem de **OpenCode**
(`opencode models --verbose --pure`) bağlantılarını destekler; OpenCode üzerindeki
ücretsiz modelleri (`cost.input === 0 && cost.output === 0`) otomatik olarak `free`
grubuna ayırır. Mevcut manuel gruplar korunur; yeni modeller `unassigned` veya `free`
grubuna eklenir.

## Ödeme / Plan Türleri ve Özel API Sağlayıcıları

Her bağlantı (`route`) aşağıdaki `billing` modlarından biriyle tanımlanır:

- `subscription`: Resmî CLI aboneliği (ChatGPT Plus/Pro, `claude.ai` Max/Pro vb.).
- `token_plan`: Sabit kotalı/abonelikli coding veya token planları (ör. Claude Code veya OpenCode üzerinden bağlanan Qwen/DashScope Coding Plan, GLM Coding Plan, MiniMax Token Plan).
- `free_credits`: Günlük veya promosyon kredi tanımlı hesaplar (ör. MiniMax `mmx` günlük kredileri — aktif token plan aboneliği olmasa bile günlük kredilerle kullanılabilir).
- `free`: Ücretsiz modeller (ör. OpenCode içindeki ücretsiz sağlayıcı modelleri).
- `paid_api`: Kullanım başına ücretli API. Varsayılan olarak otomatik model seçimine (`autoSelect: false`) girmez; yalnızca `routeId` açıkça seçildiğinde veya kullanıcı `autoSelect: true` açtığında kullanılır.

### Özel API (Anthropic veya OpenAI Yuvası) Ekleme

Web yönetim ekranındaki **"Özel API / Token Planı Ekle"** formundan veya yerel yapılandırmadan
istediğiniz ücretli/ücretsiz API'yi ya da abonelik API'sini (ör. Qwen/DashScope, DeepSeek,
OpenRouter, Kimi, yerel vLLM) iki yuvadan biriyle havuza ekleyebilirsiniz:

1. **Anthropic Uyumlu (`api.protocol: "anthropic"`)**: Claude Code CLI üzerinden `ANTHROPIC_BASE_URL` ve `ANTHROPIC_AUTH_TOKEN` izole alt süreç ortamına enjekte edilir.
2. **OpenAI Uyumlu (`api.protocol: "openai"`)**: OpenCode CLI üzerinden `OPENCODE_CONFIG_CONTENT` ile özel sağlayıcı (`@ai-sdk/openai-compatible`) ve görev bazlı salt-okunur/yazma izinleri enjekte edilir.

API anahtarları `config.json` içine yazılmaz; yerel veri dizinindeki `secrets/<secretRef>.key`
dosyasında saklanır ve tarayıcıya veya MCP istemcilerine hiçbir zaman geri döndürülmez.

## Sağlayıcı Kapsamı ve CLI Giriş Yönlendirmesi

| Adaptör | Desteklenen Plan / Modlar | Otomatik Keşif / Kota | CLI Giriş Komutu |
|---|---|---|---|
| **Codex** (`codex`) | `subscription` | Canlı model/efor keşfi ve hesap kotası (`codex app-server`) | `codex login` |
| **Claude Code** (`claude`) | `subscription`, `token_plan`, `paid_api` (Anthropic API yuvası) | `claude auth status` ile abonelik veya token plan / özel endpoint doğrulaması | `claude auth login` |
| **OpenCode** (`opencode`) | `free`, `token_plan`, `subscription`, `paid_api` (OpenAI API yuvası) | `opencode models --verbose` ile ücretsiz ve tanımlı model keşfi | `opencode providers login` |
| **MiniMax** (`mmx`) | `free_credits` (günlük kredi), `token_plan`, `subscription` | `mmx quota show` ve `mmx auth status` ile plan/kredi durumu | `mmx auth login` |
| **Qwen CLI** (`qwen`) | `subscription`, `token_plan`, `free` | Headless JSONL (`result` zarfı), salt-okunur/metin (`write` kapalı) | `qwen` |

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
