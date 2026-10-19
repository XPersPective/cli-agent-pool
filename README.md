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

## Kurulum, Masaüstü Kısayolu ve Skill Entegrasyonu

GitHub üzerinden klonladıktan sonra tek komutla global kurulum, otomatik CLI taraması,
**Masaüstü / Başlat Menüsü kısayolu (`CLI Agent Pool`)** ve **Skills Manager skill dağıtımı** yapılır:

```powershell
npm ci --ignore-scripts
npm run setup
```

`npm run setup` (veya global kurulum sonrası `cli-agent-pool install`) şu işlemleri otomatik yapar:
1. Paketi global npm dizinine (`%APPDATA%\npm\node_modules\cli-agent-pool`) kurar; böylece uygulama kaynak kod klasöründen bağımsız çalışır ve `cli-agent-pool` komutu her yerden çağrılabilir.
2. `%LOCALAPPDATA%\cli-agent-pool` (veya `~/.local/share/cli-agent-pool`) veri dizinini oluşturur ve bilgisayardaki tüm kurulu AI CLI'ları ile modellerini (`discover` + `scan-import`) havuza aktarır.
3. **Masaüstüne (`Desktop`) ve Başlat Menüsüne `CLI Agent Pool` kısayolunu ekler.** Kısayola çift tıkladığınızda siyah terminal penceresi açmadan arka plan servisini otomatik ayağa kaldırır ve **CLI Agent Pool** yönetim ekranını bağımsız bir uygulama penceresi olarak açar (`cli-agent-pool open`).
4. Bilgisayarınızda **Skills Manager** kuruluysa `skills/cli-agent-pool/SKILL.md` yeteneğini (`cli-agent-pool`) merkezi kütüphaneye kaydeder ve tüm kodlama ajanlarına (`antigravity`, `claude_code`, `codex`, `zcode`, `qwen_code`, `opencode`, `kimi` vb.) otomatik dağıtır.

### Servis Kapalıyken Bile Otomatik Ayağa Kalkma (Auto-Start)

Havuz servisi o an çalışmıyor bile olsa:
- Masaüstündeki **`CLI Agent Pool`** kısayoluna tıkladığınızda,
- Veya herhangi bir yapay zeka **Skill** üzerinden (`cli-agent-pool status`, `cli-agent-pool select`, `cli-agent-pool run`) ya da **MCP** üzerinden (`cli-agent-pool stdio`) havuza istek gönderdiğinde,

arka plan servisi (`127.0.0.1:43127`) **otomatik olarak başlatılır** ve görevi kesintisiz yürütür.

**Not:** `%LOCALAPPDATA%\cli-agent-pool` veri dizinini repository, OneDrive veya başka bir senkronizasyon klasörü içine koymayın. Token değerlerini sohbete, komut satırı argümanlarına veya Git'e yapıştırmayın.

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
Stdio bağlantısı havuz kapalıysa otomatik başlatır. İstemci yapılandırmasına sağlayıcı anahtarı,
abonelik tokenı veya Pool erişim anahtarı yazılması gerekmez.

Araçlar: `pool_list_connections`, `pool_list_models`, `pool_get_policy`,
`pool_list_pools`, `pool_select`, `pool_assign_groups`, `pool_submit`, `pool_get_task`, `pool_list_tasks`,
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

### Havuz ve çalışma alanı

Açılış ekranındaki ana havuzlar **Yüksek / Orta / Hafif**. Bir havuza tıklayın;
aşağıdaki **Codex, Claude, Qwen, ZCode…** sekmelerinden modeli bulun, küçük **Ekle**
düğmesine basın; açılan pencerede eforu ve hedef havuzu seçin. Üstteki havuz görünümü
değişmez. Aynı model farklı
havuzlara farklı eforlarla eklenebilir. Çıkar düğmesi yalnızca seçili havuzdaki
üyeliği kaldırır. Araç kataloğu ve havuzlar ayrı hiyerarşilerdir.

Modelin `memberships: [{ group: "high", effort: "high" }]` kaydı o üyelik için
zorunlu efor tanımlar. İstemci farklı efor isteyerek bu kuralı aşamaz. Efor boşsa
CLI varsayılanı kullanılır; bu bir model veya güç kategorisi değildir. Eski `group`
ve `defaultEffort` kayıtları okunabilir; yeni üyelik listesi varsa o liste geçerlidir.

**Havuzlarım** (`selectionMode: "manual"`) açıkken her yeni
seçim/gönderim `high`, `medium` veya `low` gruplarından birini ister. Açık model veya
bağlantı seçimi de havuz üyeliğini aşamaz. **Ajan seçsin** (`"auto"`)
seçeneğinde ajan grup belirtmeden katalogdaki uygun modelleri de seçebilir. Grup
belirtilirse o grup ve üyelik eforu her iki modda da bağlayıcıdır. Eski yapılandırma
ve istemcilerle uyumluluk için `selectionMode` varsayılanı `auto`dur.

Kullanıcı onayından sonra eklenen model ve bağlantısı etkinleşir; CLI ayarlarını
inceleme, yerel oturum ve ücretli API otomatik seçim izinleri geçerliliğini korur.
Ücretli API için mevcut açık `paid_api` / `autoSelect` kuralları aynen uygulanır.
Bağlantı ve tarama ayarları ayrı **Ayarlar** sayfasındadır; bağlantılar ve ekleme
formları kapalı başlar. Katalog sayfalanmaz: seçili aracın bütün modelleri kendi
kaydırma alanındadır. Yenileme kaydırma konumunu korur.

Claude sürümleri, kullanıcı istemi göndermeden CLI kontrol protokolünün
`resolvedModel` alanından alınır. `opus` gibi alias kayıtları kesin kimliklerle
birleştirilir; mevcut havuz üyelikleri korunur. Diğer araçların da tam katalog
kimlikleri gösterilir. Sağlayıcı sürüm bildirmiyorsa numara uydurulmaz. Görev
ayrıntısı istenen kimlik, havuz ve eforu, CLI olaylarında bildirilmişse gerçek
çalışan model kimliğini ayrı gösterir.

Kotalar varsayılan açık başlar. Büyük kalan yüzdesi, kalan miktarı gösteren çubuk,
kullanım ve yenilenme zamanı görünür. **Kotaları gizle / göster** tümünü; her modelin
Kota başlığı yalnızca o modeli açar/kapatır. Kullanım yüzdeleri hesap kotasıdır; hesap ortak kotası
model başına ayrı bakiye gibi sunulmaz. Kota, kapalı bağlantılar için de okunabilir.
Codex native app-server, Claude kurulu `cclimits` gözlemcisi üzerinden sorgulanır.
Desteklenmeyen veya ulaşılamayan bilgiler açıkça belirtilir. Yeni işten önce uygun
bağlantıların kotaları 15 saniyelik önbellekle yenilenir. Kota doluysa yeni iş aynı
havuzdaki uygun alternatife atanabilir; başlamış iş otomatik tekrarlanmaz.

**Modelleri tara** öncesinde kaydetmek gerekmez. Yeni katalog kalıcı olarak alınır;
kaydedilmemiş havuz/efor/bağlantı seçimleri taslak olarak korunur ve kendiliğinden
kaydedilmez. Sonrasında **Havuzu kaydet** kullanılır.

Çalışma Alanı'nda projeler, seçili projenin görevleri ve bağımsız CLI görevleri
bulunur. **Göz at / + Klasör**, Windows'un modern yerel klasör penceresini açar;
iptal mevcut projeyi değiştirmez. Kaynak koddan küçük GUI yardımcısı Windows'un
kurulu .NET derleyicisiyle yerel uygulama verisine derlenir; ek paket veya terminal
penceresi gerekmez. Yardımcı süreç havuz supervisor'ı tarafından sahiplenilir.

Giriş kutusunun kenarındaki mikrofon sesle yazmayı, ok düğmesi göndermeyi sağlar.
Metin kullanıcı göndermeden çalıştırılmaz. Tarayıcı/mikrofon desteği veya izin
bulunmazsa yazılı giriş kullanılabilir. Hedef ve en fazla 10 Markdown skill dosyası
görev talimatlarına eklenir (dosya başına 64 KB, toplam görev 100.000 karakter).
Skill kurulumu yapılmaz.

Proje başlangıçta otomatik seçilmez; **Projeler** listesinden veya yerel klasör
seçicisinden seçilir. Ayarlarda kurulum/veri dizini ya da çok satırlı kök klasör
girişi yoktur. İzin verilen proje kökleri yine sunucuda doğrulanır.

**Kaydet** yalnızca değişiklik olduğunda etkinleşir; **Vazgeç** kaydedilmemiş
havuz/ayar değişikliklerini geri alır. Aynı üyeliği tekrar eklemek çoğaltmaz ve
varsayılan olarak mevcut eforunu korur. Efor adları Türkçe gösterilir; API değerleri
(low/medium/high vb.) değişmez. Kota sorgu sonucu ekranda JSON yerine bilgi olarak gösterilir.

Bağlı ajanlar için örnekler ve hata kodları: [Ajan API rehberi](docs/agent-api.md).

### Project Brain ve Freebuff

Project Brain 3.3.0+ ayrı skill olarak kalır; görev planını ve kalite kanıtlarını
yönetir. Varsayılan ajan keşfi ve görev yürütmesi bu Pool'a bağlanır. Servis kapalıysa
başlar; kullanıcının high/medium/low üyelikleri, sabit effort'u ve kota rezervleri
uygulanır. Kayıp yanıt aynı istek anahtarıyla, başlamış görev mevcut kimliğiyle okunur.
Başarısız yazma görevi otomatik tekrarlanmaz. Ek bir Project Brain bağımlılığı yoktur.

`cli-agent-pool rpc`, stdin üzerinden `{tool, arguments}` JSON alır; editörden bağımsız
11 ajan aracına erişim sağlar. `cli-agent-pool mcp-config` ise tokensız stdio bağlantı
ayarını üretir. Freebuff Desktop/CLI bunu `~/.agents/mcp.json` üzerinden kullanabilir.
Freebuff burada istemcidir; desteklenmeyen otomatik model yürütmesi uydurulmaz.

Üstteki **Tema** menüsünden Açık / Koyu / Sistem seçilir; tercih bu tarayıcıda hatırlanır.
Uygulama sürümü üst çubukta görünür; MCP ve CLI aynı paket sürümünü bildirir.

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
