# Devralma ve düzeltme planı — 19 Ekim 2026

## Çağrı geçmişini sınırla — 1 Kasım 2026

Kullanıcı tamamlanan eski çağrıların birikmemesini ve elle temizlenebilmesini
istedi. Terminal kayıtlar yedi gün/son 500 sınırında tamamen silinecek; UI'dan
tamamlananları temizleme sunulacak. Aktif ve needs_review kayıtları korunur.
İdempotency kaydı da geçmişle sona erer; temizleme işi yeniden çalıştırmaz.

- [x] Tam kayıt/olay temizliği; completion + saatlik 7 gün/500 terminal kayıt; UI elle temizleme. 123/123 test, check/secrets ve audit (0 açık) geçti.
- [x] Temizlik: 8 yerel geçici dosya ve 3 eski/çelişen belge kaldırıldı; belge bağlantıları düzeltildi. Boş .local ve integrations klasörlerini silme komutu otomatik politikaca engellendi; içerik kalmadı.
- [x] 2.1.1 global Windows/CLI kurulumu, 42 skill dağıtımı ve servis restart tamamlandı. Kurulu dosya hashleri eşleşti; 137 terminal kayıt, 0 aktif iş; kısa MCP haritası 641 byte. Eski üç belgenin kurulu paketten de çıktığı doğrulandı.

## Paralelliği çağırana bırak — 1 Kasım 2026

Kullanıcı 32 worker tavanını sorguladı; eşzamanlı gönderim sayısını çağıran
belirlemeli. Eski global/per-route paralellik anahtarları migrate edilip UI ve
scheduler kapıları kaldırılacak. Aynı dosyalarda reader/writer kilitleri,
karantina, native izin, gerçek sağlayıcı kotası ve idempotency korunur.
100 queued iş tavanı da bağımsız paralel gönderimlere gizli tavan olmamalı.

- [x] Scheduler/config/UI global ve per-route worker tavanları kaldırıldı. 128 bağımsız iş aynı anda başladı; 64 reader ve FIFO writer kilidi doğrulandı. 100 queued iş ve bir saat görev tavanı kaldırıldı. Süre varsayılanı 300 saniye; çağıran değiştirebilir (Node timer üst sınırı 2147483 saniye). Payload ve sayfalama sınırları worker sayısını sınırlamaz.
- [x] 121/121 node:test; check/secrets geçti; npm audit 0 açık. 2.1.0 global Windows kurulumu ve 42 skill dağıtımı tamamlandı. Servis yeniden başlatıldı; kurulu kaynak hash eşleşmesi, legacy sınırların runtime kaydından silinmesi ve dört kategori MCP readback ile doğrulandı.

## Kategori/katalog hizmet sözleşmesi — 1 Kasım 2026

Kullanıcı: seçim/gruplama yetki modlarını UI ve protokolden kaldır. Çağıran
talimatı kategori veya katalog seçimini belirler. UI'da özel kategoriler oluştur,
yeniden adlandır, kaldır ve modellere üyelik/varsayılan efor ata. Kapalı/gizli
bağlantılar dışarı sunulmaz; kategoriden çıkarma katalog erişimini engellemez.
Mimari: eski mode alanları yalnız giriş migrasyonunda kabul edilip kayıttan
çıkarılır. Kategoriler veri olarak saklanır. Katalog category üyeliğinden bağımsız,
tekil ve sayfalı; kategori endpointi önce özet, seçilince kısa model sayfası verir.
Efor category için varsayılandır, native desteklenen caller tercihi geçerlidir.
Kısa help haritası ve error-code başına isteğe bağlı teşhis; normal yanıtlarda
prompt/event/katalog dökümleri yok. Native izin, billing, görünürlük ve kilitler
korunur. Servis hâlen tek kullanıcılı yerel servis; çoklu eşzamanlı istemci destekler.

- [x] Config migrasyonu/özel kategoriler, katalogdan bağımsız seçim ve efor.
- [x] İki kısa keşif girişi, sayfalama, kota özeti ve ayrı hata/help haritası.
- [x] UI mode kaldırma, kategori CRUD ve dinamik üyelik/efor kontrolleri.
- [x] Skill/CLI/doküman sadeleştirme, anlamlı regresyon ve gerçek UI kontrolü.
- [x] Test/check/secrets/audit, kurulum/dağıtım ve kurulu MCP kabulü.

2.0.0 kanıt: 121/121 test; syntax, secrets (76 dosya) ve audit (0 açık) geçti.
Gerçek Playwright tarayıcısında izole owner UI üzerinden Araştırma kategorisi
oluşturma, native model üyeliği ve low varsayılan efor, yeniden adlandırma,
kategori silme ve reload sonrası katalog modelinin korunması doğrulandı.
Console error/warning 0; eski seçim/yetki kontrolleri DOM'da yok. Eski provider
metadata group etiketlerinin istemeden owner kategorisi olmaması ayrıca testli;
ilk canlı migrasyondaki yalnız bu oturumda üretilmiş vendor kategorileri geri
alındı, önceki high/medium/low/free ve gerçek üyelikleri korundu.
Kurulu MCP: kısa harita 641 byte, katalog kaynak özeti 489 byte, tek model 274
byte (ölçüm anı). Qoder modelini kategori belirtmeden çağırma succeeded/OK;
varsayılan task cevabında prompt/events yok. Aktif/kuyrukta iş 0 iken daemon
2.0.0'a geçirildi. UI/katalog/category native izin, billing, saklama ve workspace
kilitleri korundu. Açık Edge app penceresinin Computer Use kontrolü, URL güvenle
doğrulanamadığı için durduruldu; kullanıcı penceresine input gönderilmedi.
İzole tarayıcı kabulü tamam; açık eski masaüstü sayfası elle yenilenmeli.
Son paket/servis kontrolü: final kaynak ve kurulu 2.0.0 kod hash'leri eşit;
Skills Manager 42/42 hedefte giriş ve operations referansı eşleşiyor. Dört gerçek
owner kategorisi korundu. Kurulu kategori özeti 206 byte; katalog kaynak özeti
489 byte; tek ücretsiz model sayfası 274 byte. Kategori model sayfası limit2
ile 2/8 ve nextOffset2 döndürdü. Kaynak etiketlerini owner kategorisine çevirmeyen
migrasyon final pakette; geçici UI test servisi ve tarayıcısı kapatıldı.

## 1 Kasım 2026 — kısa ajan akışı ve tüm Windows kurulumu

Kullanıcı kapsamı: bilinen havuz/model için repo taraması veya tam katalog okumadan
iş gönderme; gerekli native araçlar; ZCode Individual/Starter, Qoder/Freebuff ücretsiz
erişimleri ve MiniMax hesap kredileri; paket/CLI/Windows/skill dağıtımını tamamla.
Servis güncellemesi aktif diğer işlerden dolayı bekletilmeyecek (açık kullanıcı izni).
Mimari: mevcut submit zaten seçer; gereksiz select/list döngüleri yönergelerden
çıkarılacak. Filtreli, sayfalı kısa keşif ayrı araç olacak; model/provider kurulumu
ile her görevde keşif birbirinden ayrılacak. Native izinler/billing sınırı korunur.

- [x] Kısa filtreli katalog aracı/CLI ve doğrudan submit akışı; anlamlı node:test.
- [x] Kısa skill girişi, gerektiğinde ayrıntı referansları; aynı yönergeyi dağıt.
- [x] ZCode resmî unified CLI/Web Starter desteğini kaynak/doküman ve native çağrıyla
  araştır; API modellerini Starter olarak sunma, credential kopyalama yok.
- [x] Qoder/Freebuff headless ve ücretsiz plan sözleşmesini, MiniMax free_credits
  gerçek çağrısını doğrula; desteklenenleri ekle, engelleri ölçülebilir kaydet.
- [x] npm test/check/secrets/audit, Windows paket kurulumu/kısayollar, skill dağıtımı,
  daemon yeniden başlatma ve kurulu sürümden gerçek MCP/worker kabul kontrolü.

Araştırma ve gerçek kabul kanıtı: Qoder resmî Windows CLI 1.1.81 kuruldu,
native browser login tamamlandı. Native --list-models ve status doğrulandı;
Qwen3.8-Flash text OK sonucu billable:false, total_cost_usd:0, total_credits:0
bildirdi. Pool adaptöründen gerçek Write/Read ile proof.txt tam OK\n üretildi;
ayrı native Bash node --check testi scoped native allow grants ile exit 0 verdi.
Permission skip/bypass bayrağı yok; read/text araç kapsamı ayrıdır. Kalan Qoder
hesap kredisi CLI status'ta sunulmadığından bilinmiyor. Freebuff 0.2.35 güncel
--help yalnız interaktif seçenekler sunar; headless/model/output sözleşmesi yok,
bu nedenle ücretsiz UI modelleri sahte Pool worker olarak eklenmedi.

MiniMax native free_credits rotasında ayrı M3.1-Flash ve M2.7 text çağrıları
insufficient balance (1008) döndürdü. Hesap engeli korundu; ücretli API fallback yok.

ZCode resmi dokümanının unified CLI/Web dağıtımı incelendi:
https://github.com/zai-org/ZCode/blob/main/README.en.md . v3.17.1 yayımlanmış
asset'leri desktop platform paketleri ve checksum; kurulu ham CLI Web launcher
değil. Resmi standalone source yalnız individual-coding-plan hesabını provision
ediyor. Açık native default Starter seçimiyle -p testi bile zai-api/GLM-5.3'e
düşüp HTTP429 verdiği için başarı sayılmadı. Ardından secret-free account-only
config ile iki plan ayrı ayrı denendi: Starter ve Individual her ikisi de
Select a model before sending a message döndürdü; kişisel API provider kalmadı.
Native CLI browser login 120s içinde tamamlanmadı. Credential taşınmadı; native
default Individual GLM-5.3-Flash olarak seçildi. Starter CANLI ÇALIŞMA halen açık.
Native hesap loader desteği olmadan config ismi değiştirerek çalışmış gibi
sunulamaz. https://github.com/zai-org/feedback/issues/1014 .

1.9.0 tamamlanan dağıtım/kabul: 119/119 test, syntax, secrets (73 dosya),
npm audit 0 açık, skill validator ve git diff --check geçti. npm run setup
paketi global kurdu, C# launcher/Windows kısayollarını doğruladı ve Skills Manager
üzerinden 42 mevcut ajan hedefine dağıttı. Kısa giriş 3888 byte; ayrıntı referansı
yalnız gerektiğinde yüklenir. Codex/library/native Antigravity giriş ve referansları
kaynakla eşleşir. Eski daemon kontrolünde aktif/kuyrukta iş 0 idi; tanınan tek
Pool daemon'u yeniden başlatıldı, authenticated metadata 1.9.0 ve 12 MCP aracı
döndürdü. Kaynak/kurulu adapter, catalog, zcode-plan ve agy-project hash'leri aynı.
Kurulu CLI'den free havuzuna tek run isteği Qoder/Qwen3.8-Flash seçti, native
dosya yazma/okuma ve node --check ile succeeded/valid completed raporu verdi;
gerçek dosya içeriği ana süreçten doğrulandı. Antigravity low havuzundan aynı
gerçek write/check kabulünü geçti; yalnız bu probe'un doğrulanan geçici dosyası
kaldırıldı. Önceki işler/karantinalar ve diğer modellerin ayarları korundu.
Ölçülen sıcak MCP pool_catalog sorgusu 7ms/484byte; eski tam model çıktısı
82976byte idi. Bu ölçüm native model çalışma süresi veya gelecekteki gecikme
garantisi değildir. Gerçek görevler kaynak taraması/ayrı select gerektirmez.
Qoder native modelleri içe aktarıldı; yalnız sıfır-billable kanıtlı Qwen3.8-Flash
free ve low havuzlarına alındı. Diğer Qoder modelleri sahibin gruplaması için
atanmamış kaldı. Starter native çalışma ve MiniMax bakiye engelleri AÇIK;
Freebuff interaktif modellerini worker olarak kullanma desteği YOK.

## 1 Kasım 2026 — Antigravity proje izinleri ve ZCode Starter

Kullanıcı mevcut dizinde Antigravity dosya/komut/Pool erişiminin önceden
yetkilendirilmesini ve ZCode Starter yolunun düzeltilmesini istedi.
Mimari inceleme: Pool task scope ile native proje izinleri ayrı katmanlar;
`accept-edits` komut izni vermez. Bu projenin native kaydı mevcut fakat
settings/permissionGrants boş. Global diğer proje politikaları korunacak.
ZCode bağımsız CLI hesap registry/model provisioning sözleşmesi upstream
kaynak ve kurulu bundle üzerinden araştırılacak; credential kopyalanmayacak.

- [x] Mevcut Antigravity projesinin kalıcı native izinlerini yedekli güncelle;
  dosya okuma/yazma ve native komutla canlı doğrula.
- [x] Pool'un çalışma diziniyle native Antigravity proje eşlemesini doğrula;
  gerekiyorsa en yakın kayıtlı proje seçimini ekle ve node:test ile denetle.
- [x] ZCode Starter için desteklenen provisioning/model seçim yolunu araştır,
  mümkünse gerçek plan çağrısıyla doğrula; kalan engeli somut kaydet.
- [x] npm test/check/secrets/audit; canlı kanıt ve sınırlamaları güncelle.

Kanıt: 114/114 node:test, syntax ve secrets (67 dosya) geçti; npm audit 0 açık.
Antigravity mevcut proje grant'lerine yalnızca bu kullanıcının onayıyla proje
dosya okuma/yazma, command(*), Pool MCP ve read_url(*) eklendi; proje ayarları
komut/artifact review için güncellendi. Önceki yerel proje dosyası yanında
yedek tutulur, Git'e eklenmez. Global CLI izinleri ve diğer projeler değişmedi.
Native `agy mcp add` ile eksik cli-agent-pool stdio kaydı eklendi. Canlı native
MCP pool_get_policy çağrısı selectionMode:manual döndürdü. Yeni adaptör gerçek
dosya oluşturdu; içerik ana süreçten tam doğrulandı, node --check geçti ve yalnız
bu probe dosyası kaldırıldı. Native deny kuralları ve task scope korunur.

ZCode Starter CANLI BLOKER: kurulu 0.17.1 app-server session/create isteği,
istemci runtime-preferences yanıtı sağlandıktan sonra bile
`Provider Registry 中不存在 Model: account:zai-start-plan/GLM-5.3-Flash`
ile -32603 döndürdü; inference başlatılmadı. Güncel resmi kaynak commit'i
`a60ba6a7e5a06742270ca605f5d2cc2766afa7e1` üzerinden incelendi.
`standalone-account-provider-runtime.ts` yalnız mode:individual-coding-plan
sağlayıcılarını yükler; Starter provisioning eklenmeden bu yoldan Starter
hesabı kullanılamaz. Upstream #1014 aynı registry sınırlamasını açık tutuyor.
`-p` yerel seçimi new-provider/qwen3.8-max olarak okuyordu ve canlı çağrı 429
verdi; bu yanıt Starter başarısı sayılmadı. Hesap/model seçimi değiştirilmedi,
credential kopyalanmadı, ücretli fallback yok. Starter canlı çalışma maddesi açık.

Adaptörün kurulu 1.8.5 kopyası, önceki içeriğin kaynakla birebir eşleşmesi
doğrulandıktan sonra yalnız yeni resolver ve adapter değişikliğiyle güncellendi.
Başka projenin aktif Antigravity işi varken daemon kesilmedi; kod değişikliği
bir sonraki servis başlangıcında yüklenir.

## ZCode Start Plan doğrulaması — 1 Kasım 2026

- [ ] ZCode Start Plan GLM-5.3-Flash'i Pool'dan canlı çalıştır. Bu madde açık;
  model/hesap seçimi doğrulanmadan başarı kabul edilmez.

Yerel sürümler: güncel ZCode masaüstü 3.17.1; masaüstü kurulumunun içindeki
Pool CLI `C:\Program Files\ZCode\resources\glm\zcode.cjs` 0.17.1. `-p`
yardımında `--model`/`--provider` seçeneği yok. Kullanıcı ayarında
`account:zai-start-plan` için `GLM-5.3-Flash` kişisel modeli mevcut; gizli
credential değerleri okunmadı veya kopyalanmadı. Pool'un `session/create`
isteği bu modeli `Provider Registry` içinde bulamadığı için reddedildi; model
çağrısı başlamadı. Aynı standalone registry sınırlaması, ZCode CLI'nın
`provider/updateAccountConfig` ile sağlanan hesap durumunu tek başına
provision edemediğini bildiren açık upstream raporuyla da örtüşüyor:
https://github.com/zai-org/feedback/issues/1014 .

Sonuç: model kataloğunda Start Plan'ı `zcode-default` gibi sunup CLI'nin başka
model çalıştırmasına izin vermek kota tüketimini yanlış yönlendireceğinden
yapılmadı. Bu kurulumda Start Plan için desteklenen host/hesap aktarımı
bulunmadan canlı çağrı başarıyla doğrulanmış sayılamaz. Upstream CLI dağıtım
yönergesi kaynak derlemesi ve tam workspace bağımlılıklarını gerektirir; yalnızca
masaüstü uygulamasını güncellemek Pool'un bundled CLI'sine ayrı bir modele
yönlendirme özelliği kazandırmamıştır:
https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/01-quickstart.md .

## 1 Kasım 2026 — kullanıcının öncelikli uçtan uca hesap/CLI doğrulaması

Kullanıcı kapsamı (Goal, değiştirilmeden): mevcut havuzdaki Antigravity, Codex,
Claude, Qwen International Cloud Official/token planı + Qwen terminalindeki kişisel
API ayarı, MiniMax Code planı ve `mmx` günlük kredisi, ZCode GLM Coding Lite ve
varsa geçici Start/Coding kampanya planı, OpenCode ücretsiz modelleri, Freebuff /
WorkBuddy MCP entegrasyonu. Hesap değişikliği login/readback olarak fark edilmeli;
oturum yoksa kullanıcıya giriş yolu gösterilmeli. Mevcut model havuzu/katalog ve
filtre davranışı korunmalı. Başarı yalnızca ilgili CLI giriş yolu, kota/plan
readback'i ve uygun küçük gerçek çağrıyla kanıtlanır. API billing'e fallback yok.

- [ ] Qwen: terminal 0.21.x ve Pool 0.26.x girişlerini aynı native auth store,
  International provider/model ve seçili `envKey` üzerinden karşılaştır; preflight
  sonucunu CLI login doğrulaması ve kota sorgusundan ayır. Kota dolu/unknown/401/
  network failure durumlarını doğru etiketle; gerçek görev seçimi/yürütmesi ve
  model-kota eşlemesini test et. Kullanıcı terminal/API credential değerlerini
  okuma, kopyalama veya loglama.
- [ ] MiniMax: `mmx` ile `mcode` kimlik ve komutlarını ayır; `mmx` auth status,
  günlük free-credit bakiyesi ve `MiniMax-M2.7` gerçek CLI çağrısını yeniden
  incele. Editörün başarılı hesabı ile CLI'nin farklı billing/auth kapsamını
  açıklayan satıcı kanıtı veya güvenli bir teşhis topla; yalnızca açıkça
  `free_credits` rotasıyla dene, API billing/fallback kullanma.
- [ ] ZCode/Z.AI: güncelleme tamamlanınca gerçek kayıtlı executable sürümünü,
  `provider_config` içinde bireysel GLM Coding Lite ile kampanya/Start planının
  provider seçim ve token anahtarlarını (değerleri göstermeden), app-server/model
  seçimi ve monitor endpoint kapsamını oku. CLI'nin desteklediği model seçim
  sınırında iki planı ayrı rotalar/model olarak göstermek mümkünse uygula ve test
  et; değilse seçili ZCode profilinin anlık planını doğru göster, hesabın diğer
  planına varmış gibi davranma ve değiştirme/login isteğini sun.
- [ ] Antigravity, Codex, Claude: her kayıtlı havuz route'u için login/readback,
  model ID/effort ve kota status'unu yenile; uygun ve erişilebilir rotalarda kısa
  gerçek text çağrısı yap. Sadece quota cache/CLI varlığını başarı sayma.
- [ ] OpenCode: resmi `models --verbose` kataloğunu okuyup ücretsiz model
  tespitini ve toplu filtre→havuz ekleme UX/API sınırını incele; her modelin kendi
  billing'ini doğrula, OpenRouter/OpenCode API ücretli rotalarını ücretsiz gibi
  göstermeden test et.
- [ ] Freebuff/WorkBuddy: resmi desteklenen MCP akışıyla mevcut CLI Agent Pool
  bağlantısını uygulama içinden readback et; araç listesi ve zararsız status/
  quota çağrısını doğrula. `Freevox` adı farklı bir istemciyse ürün/kaynak
  belirsizliğini dokümante et; CLI worker olarak varsayma.
- [ ] Değişen her mantık için node:test; `npm test`, `npm run check`,
  `npm run secrets`, `npm audit`; kurulu global paket/daemon'u aktif iş yokken
  güncelle, son RPC/quota readback'i al, kalan hesap/sağlayıcı engellerini buraya
  kanıtla kaydet. Kullanıcıya ait değişiklikleri koru; commit/push yok.

Kısıtlar: kullanıcı 1 Kasım'da `native-low/native-low`, `serial`, `execute`
yürütmeyi seçti. Bu repo Project Brain task workflow'ünü açıkça emekliye ayırmıştır;
Project Brain skill'i bu repo kuralına göre yalnızca bağlam/continuity için
kullanılır, Pool deposunda Brain dizini veya yeni ikinci plan sistemi oluşturulmaz.
Kaynak sürümü 1.8.3'ten sonraki kaydedilmiş durumdan kontrol edilecek.

## Hesap değişimi ve güncel CLI takibi — 1 Kasım 2026

- [ ] Qwen terminal launcher ile Pool giriş yolunu karşılaştır; güncel CLI ve
  International Qwen Cloud Official auth davranışını doğrula, credential saklama.
- [ ] ZCode monitor ağ/servis hatasını giriş yok olarak göstermeyi düzelt ve test et.
- [ ] Hesap değişimi, kota önbelleği, login/readback ve MiniMax güncel sürümünü
  doğrula; Freebuff ve WorkBuddy için kurulum/entegrasyon engellerini belgeleyerek
  uygun resmi çözümü araştır. Kurulu servisleri ve mevcut değişiklikleri koru.
- [ ] Gerçek sağlayıcı çağrısı veya somut hesap/kota engeli, test/check/secrets/audit
  ve kurulu servis/skill doğrulamasıyla sonuçları kaydet.

1 Kasım devamı: Qwen giriş durumunu düzeltmek için güncel CLI’ın kullanıcı ayarındaki
seçili sağlayıcı/model ile anahtar varlığı artık bellekte kontrol edilir; anahtar
değeri okunup dönülmez. Eksik anahtar `AUTH_REQUIRED`, var anahtar `credentials_present`
olarak gösterilir; gerçek giriş/kota başarısı iddia edilmez. UI metni bu belirsizliği
ayırır ve hesap değiştirme / yeniden kontrol yolunu açık tutar. Test, International
QwenCloud modelinin anahtarını doğru endpoint ile eşleştirir ve anahtarın çıktıya
sızmadığını doğrular. Qwen’in güncel resmi yönergesinde OAuth `qwen auth status` akışı
kaldırılmıştır; `qwen` → `/auth` → QwenCloud → Token Plan → International seçimi anahtarı
Qwen’in kendi settings dosyasına kaydeder, Pool’a token callback’i dönmez.

Yerel gerçek durum (çıktılara credential dahil edilmeden): terminal Qwen 0.21.3,
Pool kaydı 0.26.5; ikisi de aynı kullanıcı ayarında International token-plan anahtarı
buluyor. Pool’dan seçili Qwen3.8 Max gerçek kısa çağrısı `QUOTA_EXHAUSTED` verdi:
Token Plan aylık kotası 3 Kasım 2026 16:00 UTC’ye kadar dolu. Bu giriş modülü hatası
değil; yeni hesap veya kota yenilenmesi olmadan başarılı inference doğrulanamaz.
ZCode 0.17.1 kotası bu kontrolde 429/rate-limited; kullanıcı güncellemesi henüz
kurulumda görünmüyor. Antigravity 1.4.12 kota servisi kullanılabilir dört pencere
döndürdü; önceki bakım kaydındaki kısa çağrı kanıtları geçerlidir. Codex 0.153.4
yerel auth kontrolünü geçti. `mmx` 1.0.27 auth durumu OAuth, fakat plan yok ve günlük
kredi bakiyesi bilinmiyor; günlük kredi inference henüz kanıtlanmadı. Ayrı `mcode`
0.6.8 token-plan rotası güncel hesap durumu diye varsayılmadı. Gerçek hesap/model
matrisi kapanmadan tüm bağlantılar sorunsuz ilan edilemez.

Tek kısa native MMX `MiniMax-M2.7` text çağrısı açık `free_credits` rotasında
`QUOTA_EXHAUSTED` döndü; ücretli API yolu denenmedi ve otomatik tekrar yapılmadı.
Qwen’in iki admission çağrısı da aynı aylık kotayı bildirdi; ikinci görevin sonucu
okunup kapatıldı. Freebuff’ın `~/.agents/mcp.json` dosyasında `cli-agent-pool` stdio
sunucusu zaten kayıtlı. WorkBuddy AI 5.9.4 kurulu ve açıldı; UI kontrolü sırasında
eşzamanlı kullanıcı girdisi algılandığından bağlantı ayarına müdahale edilmedi.
Bu nedenle WorkBuddy connector ekleme/readback’i ve Freebuff uygulama içi araç
readback’i bekliyor; yalnızca dosya kaydı veya resmi doküman bu kanıtı sağlamaz.

1.8.3: Qwen preflight seçilen modelin provider/envKey kaynağını kontrol eder; Qwen
resolver’ındaki id+baseUrl fallback sırasını izler ve settings.env, process env,
QWEN_HOME, eski `security.auth.apiKey` ve Qwen’in user/project `.env` aramasında
yalnızca anahtar varlığına bakar. Değerler dönülmez veya kaydedilmez; boşluk-only
değerler yok sayılır. Pool `checkAuth` için model ID iletilir. UI, anahtar bulundu
durumunu gerçek API başarısından ayrı gösterir.

Bağımsız incelemenin istek-model eşleştirme, stale base URL fallback’i, `.env`
kapsamı ve boşluk değerleri bulguları düzeltildi; son incelemede açık bulgu yok.
103 node:test PASS; `npm run check`, `npm run secrets`, `npm audit` başarılı (0 açık).
Global npm paketi 1.8.3 oldu; kayıtlı Pool servisi aktif iş yokken yeniden başlatıldı.
Canlı quota readback `qwen-local` için `auth: credentials_present`, `status: unknown`
döndü; bu yalnızca anahtarın bulunduğunu doğrular. Yeni provider çağrısı yapılmadı;
önceki kısa çağrılar aylık kotaya takılmıştı. ZCode sürümü hâlâ 0.17.1; güncelleme bu
kontrolde kurulu değildi ve quota 429/rate-limited.

Freebuff standard MCP stdio istemcisi ve WorkBuddy Settings → MCP/Connectors istemcisi
olarak dokümante edildi; bunlar model/CLI sağlayıcısı veya Pool login adaptörü değildir.
Bu oturumda WorkBuddy ya da Freebuff uygulama ayarlarına yazma ve istemci UI’sinde
bağlantı readback’i yapılmadı. Kaynak/UI dokümantasyonu testi, gerçek kurulum kanıtı
yerine geçmez.

Yeni bulgu: terminal PATH'teki Qwen standalone 0.21.3 iken kayıtlı Pool yolu
global npm CLI'dir (komut `--version` 0.26.5). Farklı giriş noktaları tek başına
farklı kimlik deposu kanıtlamaz. Mevcut çalışan route, permission ve provider
sözleşmesi doğrulanmadan otomatik değiştirilmedi. Z.AI monitor başarısızlığı artık
kimlik varlığını gösterir, plan/giriş doğrulanamadı der; 0/429/500/401 sentetik
testleri geçti. Gerçek hesap değiştirme ve UI readback doğrulaması henüz açık.

## 1 Kasım 2026 — öncelikli sağlayıcı uyumluluğu

Kapsam: Codex Sol 6.1/Astra 6/Luna 6 (Terra hariç), Claude Opus/Sonnet/Haiku
5.5 ve native Fable, Antigravity Argon/Flash/Claude, ZCode GLM plan/free ayrımı,
Qwen, MiniMax Code/günlük kredi ve WorkBuddy/Freebuff destek sınırları.
Yürütme ana ajan; native bağımsız inceleme, paralel salt okunur araştırma.
Repo Brain iş akışını emekliye ayırmış olduğundan takip bu bakım belgesindedir.

- [x] Kurulu native komut/katalog sözleşmelerini doğrula; hesap erişimini küçük
  izole text çağrılarıyla ayır; doğrulanmamış sürüm/model kimliği ekleme.
- [x] Adapter/model taşıma hatalarını node:test regresyonlarıyla düzelt;
  mevcut üyelik/eforları koru, desteklenmeyen model seçimini sessizce yok sayma.
- [x] Yerel katalogda yalnızca istenen Codex modellerini aç; Terra'yı kalıcı
  filtrele; native Claude Fable kimliğini ve erişimini doğrula.
- [x] MiniMax günlük kredilerini abonelikten ayrı doğrula; Freebuff ve WorkBuddy
  için gerçek programatik sözleşme veya somut engeli kaydet.
- [x] npm test/check/secrets/audit, bağımsız inceleme ve Brain RPC uyumluluğu;
  kurulu paket/servis durumunu aktif işlere dokunmadan doğrula.

İlk mimari bulgular: ZCode -p model bayrağı sunmuyor; Freebuff 0.2.29 yalnızca
etkileşimli CLI/MCP istemcisi. Claude native katalog Fable 5.1 bildiriyor; kayıtlı
Fable [1m] kimliğinin yeni temel kimlikle uzlaştırılması incelenecek. Credentials
resmî CLI deposunda kalır; ücretli API fallback ve native izin atlama yok.

Uygulama kanıtı: ZCode yanlış model pinleme reddi; stdout JSON hatası/kredi
sınıflaması; bir sonraki result ile önceki hata kaybının önlenmesi; JSON içinde
tırnaklı Cookie/Set-Cookie maskelemesi; MMX plansız günlük kredi bakiyesinin
bilinmiyor kalması testlidir. Skill'deki yanlış GLM pinleme örneği düzeltildi.
MiniMax Code lightweight dosya aracı sunmadığından write standard moda alındı.
Gerçek ayrı native test dosyası oluşturuldu, ana süreç OK içeriğini doğruladı.
Native smart=auto salt okunur değildir: mcode read katalog/admission ve doğrudan
çağrı düzeyinde kapatıldı; read yerine write'a otomatik yükseltme yok.

Gerçek kısa yanıtlar: Codex Astra; Claude Opus/Sonnet/Haiku 5.5; Antigravity
Argon, Flash, Opus, Sonnet, GPT-OSS; MiniMax Code M3.1 Flash. Hesap engelleri:
Sol6.1/Luna6 ChatGPT CLI tarafından reddedildi; native Fable5.1 kullanım kredisi
istiyor; Qwen aylık kota ve ZCode429; MMX günlük kredi denemesi1008 yetersiz bakiye.
Terra ve istenmeyen Codex kimlikleri yerel kalıcı filtreye alındı. Erişimsiz
Sol/Luna ve kredi isteyen Fable pasif; native kimlikler korunuyor.
WorkBuddyAI gömülü CLI hem Node hem kendi Electron runtime'ıyla eksik dist modülü
bildirdi; Freebuff --help headless sunmuyor. Bunlar çalışan Pool worker sayılmaz.
ZCode app-server seçim API'si bulundu; OAuth/host, izin, katalog/billing sözleşmesi
doğrulanmadan yeni worker yolu eklenmedi. Bu açık gereksinim tamamlanmış değildir.

Brain test_pool_modes.py ve gerçek kurulu Pool ile test_pool_integration.py geçti:
auto-start, RPC/MCP, execute raporu, fixed effort, kanıt ve no-replay kontrol edildi.
1.8.2 kurulum ve42managed skill dağıtımı yapıldı; kaynak/merkez/Codex hash'i eşleşti.
Bu oturumun araçsız MiniMax yazma probu dosya oluşturmamıştı; klasör ve rapor
incelenip yalnızca bu probe'un karantinası kaldırıldı. Diğer karantinalar korunur.
Ek native MiniMax kanıtı: --output-schema gerçek çağrıda modelin prose+JSON
yanıtını STRUCTURED_OUTPUT_INVALID ile reddetti; güvenilir yürütme yolu olarak
eklenmedi. Adapter yalnızca execute için tek, sonda duran json fence içindeki
mevcut katı rapor şemasına uyan nesneyi normalleştirir. Bozuk/çoklu rapor, native
hata ve blocked statüsü korunur; global parser gevşetilmez, tekrar yürütme yok.
exec.completed nesne output ve error ayrıştırması testlidir. Gerçek ayrı native
çağrı geçerli completed rapor verdi; tam OK içeriği ana süreçten doğrulandı.
Bu oturumun izole başarısız probe'ları içerik/rapor incelemesi sonrası çözülür;
diğer projelerin karantinaları korunur.
Son kurulu servis kanıtı: MiniMax M3.1 Flash write/execute succeeded, completed
rapor kabul edildi ve gerçek final.txt dosyasının tam OK içeriği ana süreçten
okundu.101 node:test, syntax/secrets/audit (0 açık) geçti. Bağımsız incelemenin
son delimiter gözlemi tek, tam satır json fence çiftini zorunlu kılan testlerle
kapatıldı. ZCode model seçimi/Freebuff/WorkBuddy ve hesap engelleri açık kalır;
bu kontrol listesi onların tüm modellerinin çalıştığı iddiası değildir.

## Antigravity execute repair — 30 October 2026

Owner-approved scope: repair Antigravity first, prove native write/check execution and parallel scheduling, then update installed Pool. Existing project-root writes remain exclusive/queued; no new worktrees, automatic merge, cleanup or replay.

- [x] Preserve redacted denied tool/error and blocked report, including native denied_actions with SUCCESS/empty response; show compact diagnostics and Calls panel.
- [x] Resolve inspected failed writes through authenticated live owner, preserving report/history; prohibit active-process resolution and a second SQLite owner.
- [x] Correct owner-approved native Windows command grants, prove real Flash write/check via Pool; no skip-permissions flags or other-adapter changes.
- [x] Test 32-reader concurrency and same-root writer serialization/quarantine; npm test/check/secrets/audit, installed release/runtime proof.

Source evidence:94 node:test PASS, syntax/secrets PASS, npm audit0. Real gemini-3.8-flash-medium: two text tasks overlapped; write created an actual .mjs and native node --check passed. A malformed first report was retained as INVALID_REPORT; after inspecting artifacts it was resolved without replay. The distinct queued writer then succeeded with native --json-schema and a valid completed report. Observed timestamps prove queued writes never overlapped. Runtime artifacts remain outside Git.

Installed1.8.1 verified via authenticated daemon metadata, concurrency32, and a fresh live MCP write/execute: actual file content verified, native node --check passed, completed structured report accepted. Source/installed adapters and source/Codex/Antigravity skill hashes match; Skills Manager refreshed and deployed42existing targets. Before service update actual shared active/queued tasks were0; unrelated needs_review records preserved. Only this session's inspected failed jobs resolved via the repaired live-owner CLI. Existing product source/worktrees/results preserved; no automatic retry, worktree creation, OS-sandbox promise, paid fallback or other-adapter behavior change.

## Native CLI yetenekleri ve yayın

İstenen kapsam: dosya aracı bulunan yerleşik CLI'larda istek text/read/write ile
araç kapsamını seçer; Qwen'in eski yazma engeli kaldırılır ve Antigravity'nin
eski text-only katalog kayıtları native yeteneklerle uzlaştırılır. Native izinler
ve ücret/kota kuralları korunur. Sohbet CLI'larının araçsız oluşu açık ayrılır.
Katalog yeteneği ile native izin reddi farklı bilgi olarak sunulur. İki ürünün
sürümleri, testleri, Git yayınları ve yerel skill dağıtımları doğrulanacak.

1.8 native deneme: Qwen token-plan aylık kotasının dolduğunu bildirdi; dosya
oluşmadı. Antigravity native PERMISSION_REQUIRED döndü; hedef dosya oluşmadı.
Bu izin reddi tool yeteneğinin yokluğu olarak katalogdan silinmez ve native deny
kuralı aşılmaz. Qwen auto-edit, read plan, Antigravity native mode ve stale-kinds
uzlaştırması supervisor üzerinden gerçek dosya değiştiren sentetik CLI ile testlidir.

## 30 Ekim 2026 — paralel alt ajan ve yürütme protokolü

Dağıtım devamı: Windows bağımsız npm paketini, native launcher/kısayollarını ve
canlı UI sürümünü doğrula. Çağrı görünümünde response/execute ve yapılandırılmış
raporu okunabilir göster. Ayrı Project Brain kaynağının execute/compact ve eski
dispatch kayıtlarıyla migration uyumunu doğrulayıp Skills Manager ile dağıt.

Ek kabul: bütün modal diyaloglar dışarı tıklama/Escape ile kapanmalı ve kapanış
durumu temizlenmeli. NO_ROUTE hangi havuz, yetenek, efor, kota veya bağlantı
koşulunun elediğini açıklamalı; hiçbir owner kuralı otomatik gevşetilmeyecek.

1.7.2 doğrulaması: 87 node:test, syntax/secrets ve audit geçti (0 açık). Windows
setup artık npm.cmd yerine Node/npm-cli.js kullanır, paketleme/kurulum hatalarını
yutmaz ve geçici paketi repo dışında tutar. Bağımsız global npm paketi kuruldu;
native launcher/kısayolları güncellendi ve uygulama penceresi açıldı. Canlı UI
v1.7.2 gösteriyor. Gerçek Edge oturumunda diyalog içi tıklama açık bıraktı;
dışarı tıklama ve Escape diyalogu kapatıp ayrıntı durumunu temizledi.
NO_ROUTE aday eleme nedenlerini bildiriyor; yerel low/write seçimi kota,
otomatik seçim kapalı ve yetenek sınırları nedeniyle uygun aday bulamıyor.
Bu bir ödeme/izin kuralı gevşetilerek örtülmedi. Ayrı Brain 3.6.0'ın yeni modlar,
oturum kapısı, intake/odak, migration/no-replay ve bağımsız Solo/native kontrolleri
tam test setinden geçti; kurulu Pool üzerinden sentetik entegrasyon da geçti.

Karar: salt okunur işler ortak workspace kilidi paylaşabilir; yazmalar ve inceleme
karantinası dışlayıcı kalır. Bekleyen yazma yeni okumalarla aç bırakılmayacak.
CLI kuyruk beklemesini yürütme timeout'undan ayırır ve görev kimliğini korur.
`mode: execute` yalnızca write işlerinde gerçek uygulama/komut/test talimatı ve
kısa sonuç sözleşmesi ekler; native izinler ve ödeme/kota rezervleri korunur.
Çağıran ajan kendi workspace/worktree yolunu verir. Paralel yazma için ayrı
worktree kullanır, entegrasyonu tek yazma göreviyle yapar; otomatik merge/replay yok.

- [x] Paylaşımlı okuma, yazma adaleti, karantina ve hata sonrası kilit testleri.
- [x] CLI bekleme, response/execute modları, kısa JSON raporu ve MCP/CLI sözleşmesi.
- [x] Gerçek dosya yazan subprocess regresyonu; test/check/secrets/audit kanıtı.

1.7.0 kanıtı: 83 node:test geçti; syntax/secrets ve npm audit geçti (0 açık).
32 aynı-workspace okuyucu, yazma sırası, iptal edilen yazmanın bariyeri,
worker promise hatası sonrası karantina, kuyruk beklemesinden görev kimliğiyle
dönüş, bozuk/eksik rapor ve gerçek MCP/CLI execute akışı kontrol edildi.
Native denemede iki Antigravity modeli aynı workspace içinde paralel yanıtladı;
ayrı çalışma kökünde Codex dosyayı oluşturdu, içerik kontrolü çalıştırdı ve geçerli
JSON raporu döndürdü. Dosya içeriği ana süreç tarafından ayrıca doğrulandı.
Bir önceki denemede farklı bir Codex katalog modeli native MODEL_UNAVAILABLE
döndü; katalogda bulunmak hesap erişimi garantisi değildir. O denemenin çalışma
klasöründe hedef dosyanın oluşmadığı doğrulandı; ücretli fallback yapılmadı.
Eski kesinti karantinaları korunuyor; bu bakım bunları otomatik çözmedi.
Aktif servis işi yokken servis yenilendi; canlı MCP 1.7.0, iki mod ve rapor
protokolünü bildirdi. Global npm junction bu repo'ya bağlı. Skills Manager yerel
kaynaktan güncellendi; merkez, Codex ve Antigravity dağıtımları kaynak hash'iyle
eşleşti. Commit/push yapılmadı.

Bu dosya kullanıcının birikmiş taleplerinin uygulanabilir iş listesidir. İşaretlenmemiş
işler tamamlanmış sayılmaz. Üretim sürümü başlangıç noktası: **1.4.3**, commit
`368faf13e8770a992ea7925c08eb9c93787d202f`. Bu belge bir sürüm veya test başarı iddiası değildir.

## Çalışma kararı

Pool geliştirmesi Project Brain çalışma akışına bağlanmayacak.
Pool ile Brain ayrı ürünlerdir; geliştirmede kullanılan skill'i aynı anda değiştirme
karmaşası yerine bu belge ve Git geçmişi üzerinden devam edilecek. Brain kaynakları,
kurulu kopyaları ve dağıtımı bu bakım planının parçası olarak değiştirilmedi.
Pool API değişirse ayrı Brain deposunda uyumluluk testi yapılacak; ancak gerçekten
gerekiyorsa Brain güncellenecek, sürümlenecek ve Skills Manager ile dağıtılacak.
Güncel istemci sözleşmesi [ajan API belgesindedir](agent-api.md); başlangıç/yayın hizmetleri bu projenin dışında kalır.

## Bu incelemede gerçekten doğrulananlar

- Çalışan kurulumda 13 yapılandırılmış route var. CLI varlığı ve `--help` sorguları
  denetlendi; bu, model çağrılarının başarılı olduğu anlamına gelmez.
- Codex oturum ön kontrolü başarılı. Diğer birçok route `SETTINGS_NOT_TRUSTED`
  nedeniyle ön kontrolde duruyor. Bu hata giriş yapılmadığı anlamına gelmez.
- OpenCode ve MiMo `providers list` komutu kurulu sürümlerde çalışıyor. Yerel
  sağlayıcı listesi bulunması anahtarın geçerli veya bakiyenin yeterli olduğunu kanıtlamaz.
- `checkAuth` bazı adaptörlerde yalnızca güven/plan bayrağına bakıyor; `quota`
  OpenCode/MiMo için oturum sorgusu yapmadan `available` döndürüyor.
- Antigravity `routeCatalog`, `-high/-medium/-low` son ekli kimlikleri ayrı model
  olarak alıyor. CLI gerçek yürütme kimlikleri korunmadan son ekler silinemez.
- `mergeCatalogModels` bazı yerlerde 100 modele kesiyor. Eksik katalog ile sayfalama/
  sınır durumunu, sağlayıcının gerçekten model sunmamasından ayırmak gerekiyor.
- OpenCode'un tek `free` route'u altında farklı sağlayıcılardan kimlikler bulunuyor.
  Bir sağlayıcının ücretsiz modeli diğer sağlayıcıdaki tüm modellere ücretsiz olma
  garantisi vermez. Route/model kapsamındaki ödeme doğruluğu incelenecek.
- İnceleme sırasında okunan görev deposunda failed/timed_out kaydı çıkmadı.
  Dolayısıyla kullanıcının bildirdiği Gemini hatasının gerçek hata çıktısı henüz
  yeniden üretilmiş veya teşhis edilmiş değildir; tahminle kapatılamaz.
- `napp_app_template` mevcut bir Flutter üreticisidir. Kaynağa yazmak yerine yeni
  kopyada üretim yapar. `store-publish-matic` mevcut Fastlane masaüstü aracıdır;
  Windows Store desteği veya kararlı headless API'si varmış gibi kabul edilmeyecek.
- Bu inceleme yeni giriş tamamlamadı, ücretli çağrı çalıştırmadı, credential kopyalamadı.

## P0 — Bağlantı ve yürütme doğruluğu

- [ ] Her kurulu adaptörün gerçek sürümünü, desteklediği login/status/model/run
  komutlarını doğrula: Codex, Claude, OpenCode, ZCode, Qwen, MiniMax Code, MiniMax
  CLI, Kimi, MiMo, Antigravity, OmniRoute, LM Studio ve Hermes. Kurulu olmayanı
  eksik kurulum olarak göster; kurulum varlığını çalışan model olarak sunma.
- [ ] Kurulu / yerel ayar doğrulaması gerekli / oturum gerekli / oturum doğrulandı /
  kota dolu / sağlayıcı hatası / protokol uyumsuzluğu / test başarılı durumlarını ayır.
  Bilinmeyen oturum veya kota bilgisine sahte başarı/yüzde verme.
- [ ] Yerel resmî CLI oturumunu aynı kullanıcı ve ortamla yeniden kullan. Login
  penceresi açıldığında doğru aracı ve doğru sağlayıcıyı seç. Zaten giriş varsa
  zorla çıkış yaptırma veya credential taşımaya çalışma.
- [ ] Kullanıcı adına mümkün olan resmî OAuth/device akışını başlat ve doğrula.
  Gerçek hesap seçimi/2FA/consent veya eksik API anahtarı gerekiyorsa bunu açık bir
  bekleyen kullanıcı adımı olarak göster. Tarayıcı açık diye giriş tamamlandı sayma.
- [ ] OpenCode/MiMo sağlayıcı bağlamını doğrula: model provider ID'si, CLI native
  auth deposu, native config yüklenmesi, `--pure` davranışı, izinler ve model listesi.
  Bir sağlayıcının hesabını başka sağlayıcıda kullanılabilir sanma.
- [ ] OpenCode/Kimi/DeepSeek/Hermes/Qwen/MiniMax için hangi ürünün aboneliğinin hangi
  CLI/API yoluna erişim verdiğini doğrula. Web sohbet aboneliğini API kredisi olarak
  kabul etme. Sahibi tanımlamadıkça ücretli API fallback'i veya billing değişikliği yok.
- [ ] Güven bayrağını otomatik açarak hatayı örtme. Native ayarlar/hook/plugin ve
  endpoint davranışını incele; kullanıcı kapsamı içindeki uygun ayarı doğru kaydet.
- [ ] Gemini/Antigravity başarısız çağrısını küçük text göreviyle yeniden üret;
  gerçek hata, süreç çıkışı ve CLI stream olaylarını eşleştir. CLI başarılı dönse
  bile boş/yanlış protokol yanıtını başarılı model testi sayma.
- [ ] Her kullanılabilir route için küçük, sabit, dosya değiştirmeyen gerçek test;
  düşük kota/ücret koşulları uygunsuzsa bunu engel olarak raporla. Denemeler sınırlı
  olacak; başlamış işi otomatik tekrar etme, sandbox/izin denetimlerini kapatma.

## P1 — Model kimliği, efor, katalog ve kalıcılık

- [ ] Aynı route içindeki aynı sürümün efor varyantlarını tek kartta göster.
  Antigravity için görünen model kimliği + efor -> CLI'nın gerçek kimliği eşlemesini
  sakla; `--model`/`--effort` sözleşmesini kurulu CLI üzerinde doğrula.
- [ ] Sağlayıcı/abonelik/route farklıysa aynı model sürümü ayrı kullanılabilir
  kaynak olarak kalsın; kotalar ve ödeme bağlamları birleşmesin.
- [ ] Eski üyelikleri ve sabit eforları kayıpsız taşı. Aynı canonical model+havuz
  için çakışan eski eforlar varsa sessizce birini seçme; çözülecek çakışmayı göster.
- [ ] Alias ve tam sürümü ayır. Sağlayıcı sürüm vermiyorsa sürüm uydurma; istenen
  kimlik ile CLI'nın bildirdiği çalışan kimlik ayrı doğrulanabilir olsun.
- [ ] Keşif bütün native sağlayıcıları kapsasın; eksik/yarım keşif uyarısı ve
  retry/yenileme olsun. Tarama kayıtlı üyelikleri ve gizleme kurallarını bozmasın.
- [ ] Gizlenen model/aileler yeniden tarama, sayfa/servis yeniden başlatma ve
  oturum yenilemesinde kalıcı olsun. Gizleme de model ekleme gibi kapsamı sınırlı
  kaydedilsin; diğer taslak ayarları istemeden kaydetmesin.
- [ ] Havuz, efor, görünüm, sıralama, aç/kapat ve kota gösterim tercihlerinin her
  biri için kayıt sahibi açık olsun (owner policy / browser preference). Taslak
  kurtarma başarılı kaydı eski taslakla sessizce geri almasın.

## P1 — Yönetim ekranı; sohbetin yerine çağrı izleme

- [ ] Çalışma Alanı sohbetini kaldır: composer, mikrofon, skill ekleme, hedef ve
  proje seçimi bu arayüzden çıkacak. Daha önceki chat geliştirme talepleri bu yeni
  kullanıcı kararıyla geçersizdir. Ajan MCP/CLI görev yürütmesi devam edecek.
- [ ] Yerine Çağrılar ekranı: aktif işler, son sınırlı geçmiş, route/model/efor,
  durum, zaman, okunabilir istek/yanıt ve hata ayrıntısı; ham JSON paneli değil.
- [ ] Çağıran istemci ile çalışan model/CLI'yı ayır. Kimlik bildirilmiyorsa
  "İstemci bilinmiyor" göster; ortak erişim anahtarından ajan adı uydurma.
- [ ] Çalışan model kartında sade bir durum işareti; tıklayınca mevcut çağrı,
  çağrı yoksa yakın geçmiş. Renk tek başına bilgi taşımasın; klavye/aria ve
  reduced-motion desteği olsun. Otomatik yenileme odağı/okuma konumunu bozmasın.
- [ ] Her kart içinde küçük Test et eylemi: sabit kısa text isteği, dosya yazma
  yok, prompt/skill seçici yok. Sonuç başarılı/başarısız/engelli ve açıklama olsun.
  Kota ve billing kurallarını aşmasın; ödeme gerektiren yol açıkça tanımlı olmalı.
- [ ] Test yürütmesi için sahibin proje klasörü seçmesi gerekmesin; uygulama
  verisinde izole test dizini kullan. Bu istisna ajanların workspace sınırını genişletmesin.
- [ ] İzleme görünümünde aktif çağrılar + örneğin son 50 kayıt. Ayrıntılı gövdeler
  için önerilen 7 günlük/alan sınırı ayarı ayrı değerlendirilsin; idempotency anahtarı,
  sonuç durumu ve `needs_review` karantina kayıtları log temizliğiyle silinmesin.
  Aksi takdirde eski bir retry aynı işi yeniden çalıştırabilir.
- [ ] Havuz/katalog aynı panel dili ve farklı, birbirine yakın zemin tonları;
  kartlar iki zeminden de ayırt edilsin. Açık/koyu/sistem teması, dar-geniş pencere,
  zoom dönüşü, kota aç/kapat, uzun model adı, bütün kart ve footer sınırlarını kontrol et.
- [ ] İç içe model scroll'u ve sayfalama geri gelmesin. Havuz/katalog başlık
  okları görünür, aç/kapat tercihi kalıcı olsun.

## P2 — Tarayıcı sohbet bağlantıları

- [ ] DeepSeek/ChatGPT vb. için resmî web sohbetini açma bağlantısını ayrı bir
  kullanım türü olarak değerlendir. Web oturumu CLI worker kapasitesi değildir.
- [ ] Tarayıcı üzerinden gerçek görev otomasyonu isteniyorsa desteklenen resmî
  entegrasyon/API/CLI ve kullanım koşullarını araştır; credential/cookie çıkaran,
  özel endpoint kullanan veya ücretsiz erişim garantisi veren yol ekleme.
- [ ] Desteklenen programatik yürütme yoksa "Web sohbetini aç" olarak sınırla;
  böyle bir kart otomatik havuz seçimine girmez. Ücret/kota belirsizliğini gizleme.

## Ayrı oturumda yapılacaklar — şu an skill oluşturulmayacak

- [ ] Flutter/NApp başlangıç protokolünü ayrı skill olarak tasarla ve uygula.
- [ ] Mağaza hazırlama/yayınlama protokolünü ayrı skill olarak tasarla ve uygula.
- [ ] Ortak uygulama profili, secret referansları, eksik bilgi raporu ve kanıt
  dosyaları üzerinden birbirlerine ve genel Project Brain'e devir sözleşmesini test et.
- [ ] Kullanıcı çağırmadıkça hiçbir başlangıç veya mağaza protokolü otomatik
  etkinleşmeyecek; Brain çekirdeğine Flutter/reklam/mağaza davranışı eklenmeyecek.

## Kabul ve teslim

- [ ] Birim testleri: canonical varyant eşleme, membership migration/çakışma,
  provider auth durumları, gizleme kalıcılığı, log temizliği/idempotency güvenliği,
  kart testinin izin/billing/workspace sınırları.
- [ ] Gerçek kurulum matrisi: her route için sürüm, auth kanıtı, katalog kanıtı,
  küçük çağrı kanıtı veya somut engel. Bir adaptörde geçen test diğerini geçirmez.
- [ ] Tarayıcı: dark/light, 390/900/1280/1440 genişlik, zoom daralt-genişlet,
  klavye, kart test sonucu, canlı çağrı, login yönlendirme, tüm tercihlerle reload.
- [ ] `npm test`, `npm run check`, `npm run secrets`, `npm audit`.
- [ ] İzole fixture ile yönetim API/MCP/CLI regresyonu ve ayrı Brain entegrasyon
  testi. Gerçek kullanıcı yapılandırması ve görev sonuçları Git'e girmeyecek.
- [ ] Sürüm, paket, kurulum, push/yayın ve push sonrası kurulu paket kontrolü.
  Skill açıklaması değiştiyse merkezi kaynak ve ajan dağıtımlarını da doğrula.
- [ ] Bu dosyadaki durumları kanıtla güncelle; eksik auth/mağaza işlemini
  tamamlanmış sayma. Bir sonraki ajan buradan ve son commit'ten devam etsin.

## Sonraki somut adım

P0 için adaptör başına native auth/status/run sözleşmesini doğrula ve sahte
`available` durumlarını düzelt. Ardından küçük çağrıyla Gemini hatasını yeniden üret.
Sonra canonical model/efor geçişi; ardından çağrı izleme arayüzü. Büyük UI değişimi
ile kimlik doğrulama değişimini aynı doğrulanamaz paket halinde birleştirme.

## Bu analiz tesliminin kontrolü

19 Ekim 2026: mevcut 48 node:test testi, sözdizimi denetimi, secrets taraması ve
`npm audit` geçti (0 açık). Yalnızca plan/tasarım ve AGENTS devralma bağlantısı
değiştirildi; yeni paket sürümü veya kurulum gerekmedi. Mevcut testlerin geçmesi,
yukarıdaki gerçek CLI oturumlarının veya bildirilen hataların çözüldüğünü kanıtlamaz.


## 1.5.0 uygulama kontrol noktası

Uygulandı ve runnable kontrollerle doğrulandı: Antigravity canonical model/efor
kataloğu ve atomik üyelik taşıması; `-p` argümanının sonraki bayrağı mesaj sanması
kök hatası; gerçek native ID ile düşük efor Gemini Flash kısa çağrısı (yanıt alındı).
Ortak Gemini grubunun açıkça kapsamadığı Argon bakiyesi uydurulmaz; gerçek Argon
etiketli grup varsa onun haftalık penceresi kullanılır. MiMo'nun uydurulmuş eski
fallback kimliği artık keşfe eklenmez; gerçek Xiaomi native katalog kimlikleri alınır.
Sahte `available` yerine credential varlığı/oturum bilinmezliği ayrılır.

Sohbet UI kaldırıldı; Çağrılar ekranı, aktif kart durumu, sabit text kart testi,
bağımsız kalıcı gizleme, yakın ama farklı panel zeminleri ve okunabilir hatalar
uygulandı. Gövde temizliği 7 gün/500 tamamlanan kayıt; admission anahtarları ve
karantina korunur. Salt web sohbeti bağlantıları eklendi; otomatik web worker yok.

Gerçek kurulum bulguları: 43127'deki eski servis varsayılan runtime kimliğiyle
uyuşmuyordu. Kullanıcı tek örnek kararını yetkilendirdi; aktif çocuk süreç ve görev
olmadığı doğrulanarak tanınan Pool servisi yeniden başlatıldı. Brain scan tekrar
çalıştı. Her browser penceresi için ayrı servis başlatılmıyor. Gelecek kimlik
çakışmalarında kod key değiştirmez/başka listener öldürmez; açık hata verir.

Açık, tamamlanmış sayılamayacak işler: her sağlayıcının gerçek hesap/planıyla
uçtan uca çalıştığı kanıtlanmadı. OpenCode ücretsiz native testinde sağlayıcı
`free tier can only be used from within OpenCode` kısıtı döndü; başka ücretli
rota denenmedi. Credential listesi login/abonelik kanıtı değildir. MiMo'nun gerçek `xiaomi/mimo-v2.6-flash` kısa native çağrısı kota/bakiye sınırıyla
sonuçlandı (`QUOTA_EXHAUSTED`); bu oturum hatası diye sunulmuyor. Kimi/MinMax/
Claude/ZCode/OmniRoute/Hermes ve yerel uygulama hazır oluşu için adaptör bazlı
sonuç/engel matrisi tamamlanmalı. Özellikle ZCode headless CLI seçenekleri ve seçilen
modelin gerçekten uygulanması, Hermes/OmniRoute per-call sözleşmeleri ayrıca
doğrulanmadan başarılı ilan edilmemeli. Otomatik tarayıcı sohbet worker'ı eklenmedi.

İki yeni skill'in geliştirmesinde Brain yalnızca dışarıdan takip aracı olarak
kullanıldı. Genel Brain kaynakları değişmedi, lifecycle hook/protokol bekleme eklenmedi.
İlk yüksek model alt ajanları kullanıcının kota uyarısıyla durduruldu; kalan işler
kısa, geçmişsiz düşük model görevlerine ayrıldı. Windows junction regresyonları
Project Forge (10 test) ve Release Harbor (11 test) üzerinde çalıştırıldı.


## 1.5.1 havuz seçimi kalıcılığı

20 Ekim 2026: model üyelikleri kalıcı kaydedilirken Model seçimi ve ajan düzenleme
izni yalnızca tarayıcı taslağında kalıyordu. Bu nedenle yeni oturumda sunucunun
önceki seçim politikası uygulanıyordu. Her iki tercih artık filtrelerle aynı dar
kapsamlı otomatik kayıt akışını kullanır; ilgisiz bağlantı/ödeme taslakları kaydedilmez.
Mevcut kullanıcı politikası yükseltme sırasında değiştirilmez.

54 node:test, sözdizimi, secrets ve bağımlılık denetimi; ayrıca gerçek tarayıcıda
her iki seçim modu, düzenleme izni, havuz üyeliği ve sabit efor kaydı doğrulandı.
Tarayıcı localStorage temizlendikten sonra yeniden yüklemede seçimler korundu;
ayrı diskten yükleme regresyonu da eklendi.


## 1.5.2 yerel giriş yönlendirmesi düzeltmesi

20 Ekim 2026: MiniMax Code ve mmx giriş düğmeleri açık global bölgeyi kullanır;
Kimi girişine de global bölge eklenmiştir. MiMo düğmesi doğrudan Xiaomi sağlayıcısını
seçer. Kurulu native CLI yardımlarıyla seçenekler doğrulandı; giriş launcher testi
her adaptörün gerçek argüman dizisini denetler. Qwen giriş komutu native etkileşimli
`qwen` olarak korunur; eski OAuth/ücretli API fallback eklenmez.

Yerel kullanıcı isteğiyle Qwen ayarlarının hook/MCP ve endpoint metadata incelemesi
yapıldı; hook ve MCP bulunmadı, mevcut endpointler uluslararası token-plan adresleri.
Yalnızca Qwen güven onayı kaydedildi; diğer bağlantıların güven kontrolleri gevşetilmedi.
MiMo native giriş akışı platform.xiaomimimo.com üzerinden tarayıcı yetkilendirmesi
sunuyor; anahtar elle yazmak zorunlu kabul edilmez. Hesap onayı tamamlanmadan
başarılı giriş veya geçerli abonelik iddia edilmez. .com hostname sunucunun fiziksel
bölgesini kanıtlamaz; MiMo için doğrulanmış bir bölge bayrağı yoktur.


MiMo günlük kredi düzeltmesi: kullanıcı Desktop ödül/günlük kredisi kullandığını
belirtti. Native giriş düğmesi sağlayıcıya sabitlenmez; `mimo providers login`
menüsü MiMo Auto/free ve platform/API yöntemlerinin ayrımını korur. Yerel Pool
ödeme bildirimi free_credits olarak düzeltildi. Bu değişiklik Desktop ödüllerinin
CLI/API'ye taşınabildiğinin veya gerçek günlük bakiyenin doğrulandığının kanıtı
değildir. Resmi README native MiMo Auto kanalını ayrı ve süreli ücretsiz kanal
olarak tanımlar; platform OAuth ise geçerli plan veya platform bakiyesi ister.


## 1.5.3 kota görünümü ve OpenRouter

Kota bilgisine göre Tümü/Bilinen/Bilinmeyen filtresi hem havuz üyelerine hem model
kataloğuna uygulanır. Model kapsamına uyan sayısal kalan kota bilinen sayılır;
yüzde sıfır bilinendir, null/NaN/başka modele ait kota bilinmeyendir. Seçim diğer
browser görünüm tercihleriyle saklanır; routing veya kullanıcı havuzları değişmez.
Dar ekran, iki panel ve yeniden yükleme gerçek browser üzerinde doğrulandı.

OpenRouter yerel OpenCode provider listesinde kayıtlıdır; bu tek başına geçerli
anahtar/bakiye kanıtı değildir. Kullanıcı yalnızca ücretsiz kullanım istediği için
OpenCode bağlantısı free olarak kaydedildi. Native katalogda sıfır giriş/çıkış
fiyatı doğrulanan :free model için bir sabit kısa probe başlatıldı; başka modele
replay veya ücretli fallback yok. Ücretli OpenRouter modellerini owner açıkça
paid_api seçse bile dışlayan katalog koşulu düzeltildi; free/free_credits/token_plan
üzerinden ücretli OpenRouter katalogları açılmaz. Dört billing modu regresyonla
kontrol edilir. 55 node:test, syntax/secrets/audit geçti (0 bağımlılık açığı).


OpenRouter gerçek probe sonucu: native katalogda ücretsiz olduğu doğrulanan model
admission'dan geçti fakat TIMEOUT ile sonlandı; yanıt alınmadı. Giriş reddi veya
başarılı native inference kanıtı yok. Görev tekrar edilmedi, ücretli fallback yok.
OpenRouter sağlayıcı yürütmesinin neden yanıt vermediği açık takip işidir.


## 1.5.4 yerel proje erişimi

20 Ekim 2026: kullanıcı kararıyla Pool proje izin listesi kaldırıldı. CLI, MCP,
yeniden başlayan kuyruk ve proje skill keşfi mevcut mutlak klasörleri kabul eder.
CLI artık proje eklemek için owner yapılandırmasını yazmaz. Eski workspaceRoots
yalnızca dosya biçimi uyumluluğu için okunur; silinmiş proje kaydı servisi engellemez.
Katalog/kota sorguları runtime dizinini kullanır. Native CLI izinleri, görev kapsamı,
canonical overlap kilidi, karantina ve izole kart testi sınırları korunur.

57 node:test geçti; kayıtsız MCP/CLI yürütmesi, yapılandırmanın değişmemesi,
geçersiz dosya/yol, junction canonicalization ve eski kayıtlar kontrol edildi.
Sözdizimi, secrets ve npm audit kontrolleri geçti (0 bağımlılık açığı).

Kurulu global paket ve çalışan servis 1.5.4 olarak doğrulandı. Aktif görev/çocuk
süreç yokken servis yenilendi. Gerçek chatimus yolu canlı MCP admission denetimini
geçti; var olmayan test rotası NO_ROUTE ile durdu, model çağrısı yapılmadı.
Skills Manager yerel kaynaktan güncellendi ve mevcut 41 ajan dağıtımı doğrulandı.
Setup helper global npm kurulumunda timeout verdi; paket doğrudan npm ile kuruldu.
Bu bakım sırasında commit veya push yapılmadı.


## 1.5.8 Windows panel baslatma ve singleton

20 Ekim 2026: gercek kisayol hatasi DAEMON_IDENTITY_CONFLICT olarak yakalandi.
Codex MSIX LocalAppData sanallastirmasi nedeniyle ayni mantiksal yol desktop
ve Codex baglaminda farkli token/config dosyalarina gidiyordu. Native GUI
baslaticisi runtime dizinini kendi fiziksel exe konumundan alir; Node ensure
ciktisini UTF-8 pipe ile okur, SQLite uyarisini JSON hatasindan ayirir.
VBScript yerine iki Windows kisayolu bu helper'i kullanir. Ayni runtime icin
named mutex ve profil kapsamli pencere kesfi tekrar tiklamada mevcut pencereyi
one getirir, ek Pool pencerelerini kapatir. Kisisel browser ve worker'lar ayridir.

58 node:test, syntax/secrets/audit gecti; native kaynak kurulu .NET compiler ile
derlendi. Panel kapaliyken kisayol exit 0, gorunur Pool penceresi ve uc
eszamanli kisayol cagrisinda tek pencere dogrulandi. Onceki Computer Use denemeleri fiziksel Escape sinyaliyle kesildi. Iki Antigravity aboneligi icin hesap izolasyonu
eklenmedi. Kota kaynagi Gemini ve Claude/GPT gruplarini veriyor; Argon grubu
bulunmadigi icin bu kaynaktan Argon bakiyesi dogrulanamaz.

Gercek UI kontrolu tamamlandi: panel Alt+F4 ile kapatildi; Explorer Masaustu
klasorundeki CLI Agent Pool simgesine sky.click(click_count:2) ile tiklandi.
MSEdge CLI Agent Pool penceresi olustu. Ikinci gercek cift tiklamada ayni tek
pencere kaldi. DAEMON_IDENTITY_CONFLICT kaydi MSIX fiziksel runtime duzeltmesinin
kokusudur; SQLite ExperimentalWarning tek basina acilis hatasi degildir.
1.5.8 global paket ve yeni native kisayollar kuruldu; commit/push yapilmadi.


## 1.5.9 gercek isci sonuclari ve ortak runtime

21 Ekim 2026: Antigravity event/step_update/result protokolu gercek kayittan
dogrulandi. Native SUCCESS, tool_info.error icindeki izin reddini ortmuyordu;
artik PERMISSION_REQUIRED donuyor ve yazma sonucu inceleme gerektiriyor. Ham
NDJSON bir ajan yaniti olarak basarili sayilmiyor. Runtime ayarinda Antigravity
modellerinin write yetenegi kaldirildi; native deny kurallari degistirilmedi.

Tek fiziksel runtime user-profile locator ile paylasiliyor. Eski kabul kayitlari
ve karantinalar korunuyor. Kuyruk yaniti inceleme kilidini ve engelleyen gorevi
acikliyor. autoSelect:false tum billing turleri icin otomatik secimden disliyor;
ajanlar basarisiz testi route pinleyerek asmayacak sekilde skill guncellendi.

Gercek kisa testler: Codex Astra metin yaniti ve izole klasorde probe.txt yazma
icerigi dogrulandi. Antigravity Sonnet metin yaniti alindi; yazma izinleri reddediliyor.
Kimi saglayicisi mevcut aboneligin Code erisimi olmadigini 403 ile bildirdi;
SUBSCRIPTION_REQUIRED siniflandirmasi eklendi. Claude/ZCode CLI_FAILED, Qwen ve
MiniMax Code 20 saniyelik testte TIMEOUT, MiMo QUOTA_EXHAUSTED dondu. MMX icin
atanmis test modeli yok. Bu baglantilar otomatik secimden cikarildi; ucretli
API inference testi veya ucretli fallback yapilmadi. Yeni yazma gorevleri icin
medium havuzunda dogrulanmis uygun baglanti yoksa NO_ROUTE donuyor; guc grubu
sessizce yukseltilmiyor. Bu saglayicilar calisiyor diye ilan edilmedi.

Son kontroller: 62 node:test, syntax/secrets/audit gecti. Codex yazma probunun
dosya icerigi gercekten OK olarak okundu. Antigravity dosya okuma probu 20 saniyede
TIMEOUT verdi; su an yalnizca text yetenegi acik birakildi. Yerel canli kontrol
sonuclari runtime icinde tutulur; proje kodu veya task promptu Git
e eklenmedi.


## 1.6.0 kendi kota katmani ve CLI duzeltmeleri

21 Ekim 2026: harici cclimits bagimliligi kaldirildi. `src/quotas.js` Claude OAuth
kullanimi, Z.AI monitor, Antigravity Cloud Code (Windows Kimlik Bilgisi Yoneticisi
salt okunur), Kimi Code, MiniMax Coding Plan ve OpenRouter anahtar/bakiye sorgularini
kendisi yapar. Kimlik bilgisi CLI deposundan yalnizca bellekte okunur; yenilenen jeton
geri yazilmaz. Suresi dolan jeton "giris gerekli" sayilmaz; yalnizca oturum yoksa sayilir.
Kullanici API rotalarinda Z.AI/BigModel, OpenRouter ve MiniMax anahtar kotasi okunur.

Kok nedenler ve duzeltmeler (gercek CLI ile dogrulandi, her biri "OK" yaniti verdi):
- Claude: kullanici settings.json DashScope'a yonlendiriyordu; abonelik rotasi artik
  `--setting-sources project,local` ile claude.ai Pro uzerinden calisir.
- ZCode 0.17: `-p` saglayici katalogunu bulamiyordu ve `--output-format` secenegi yok.
  `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` + `--json` kullanilir. `-p` model secemedigi icin
  katalog tek "ZCode varsayilan modeli" gosterir. Kullanici yetkisiyle ZCode'un kendi
  `zai-api` saglayicisina Lite planli anahtar ZCode'un eski config.json kaydindan tasindi
  (yedek: provider_config.json.bak-pool-20261021); Pool'a anahtar kopyalanmadi.
- MiniMax Code: exec olay semasi ayristirilir (agent_message / exec.completed).
- OpenCode/MiMo: `summary` alt ajan oldugu icin metin gorevleri `plan` ajaniyla calisir.
- Hata kodlarinin yanina maskeli kisa saglayici mesaji `error_detail` olayi olarak eklenir.

Hesap kaynakli acik engeller (kod hatasi degil): Kimi aboneligi Kimi Code icermiyor (403,
kota yaniti bos); MiMo Xiaomi API bakiyesi yetersiz (402) ve ucretsiz MiMo Auto kapandi;
mmx'te etkin token plan yok ve bakiye bitmis (1008); OpenRouter bakiyesi negatif, ucretsiz
modeller gunluk 50 istekle sinirli. Antigravity kota servisi Argon icin deger bildirmiyor.
Meta Muse Code bu makinede kurulu degil; yerlesik adaptor uydurulmadi.

1.6.1: `claude auth status` de kullanici ayarindaki jetonu goruyordu (`oauth_token`);
abonelik kontrolu artik calistirmayla ayni `--setting-sources project,local` kapsaminda
yapilir. Gercek servis uzerinden kisa gorevler: ZCode, MiniMax Code, Qwen ve Antigravity
"OK" dondu. Codex `gpt-6-luna` ChatGPT hesabiyla desteklenmiyor (OpenAI 400); bu
makinede model kapatildi.

1.6.2 (30 Ekim 2026): Ayarlar ekranina Seri (1) ve Paralel (2-32; varsayilan 32) gorev siniri
eklendi; `concurrency`, rota `maxConcurrent` ve `importDiscoveredRoutes` varsayilanlari
32 ile hizalandi, eszamanli HTTP istek siniri (`inflight`) 128'e cikarildi ve `concurrency`
kaydedildiginde mevcut rotalarin `maxConcurrent` degerleri eszamanli guncellenir. Global npm
junction/symlink uzerinden calistirilan masaustu kisayolunun `bin/pool.js` icinde `realpathSync`
cozumlenmedigi icin bos cikti verip `dashboard.cs` icinde `NullReferenceException` firlatmasi
ve penceresiz kalan `dashboard-browser` profil kilidi (`RetireWindowlessProfile`)
duzeltildi; symlink giris noktasi, 20/30/32 paralel workspace admission ve preference testleri
eklendi. Ayni/ic ice workspace kilidi degistirilmedi.

1.8 yayın kontrolü: 89 node:test geçti; npm run check, npm run secrets ve npm audit
başarılı (0 açık). Yeni testler stale text-only kaydı, native/configured kapsamı,
Qwen auto-edit dosya değişikliği ve Antigravity mode bayraklarını doğrular.
Brain 3.6.1 Pool'un etkin kinds değerini kullanır; önceki değişmez işler korunur.

Antigravity izin düzeltmesi: kullanıcının talebiyle native CLI settings yedeklendi;
genel write_file(*) deny kaldırıldı. Komut ve sandbox dışı komut deny kuralları
korundu; bypass bayrağı kullanılmadı. Yeni izole native çağrı succeeded/completed
raporu verdi; input okundu, output yazıldı ve ana süreç tam içeriği doğruladı.
Bu makineye özgü izin ayarı Git'e veya dağıtılan skill'e taşınmadı.

## 1 Kasım 2026 devam — sürüm, servis ve canlı kanıt

Resmi updater/paket kanalıyla güncellenip sürüm komutlarıyla doğrulananlar:
Codex CLI 0.166.0, Claude Code 2.1.316, OpenCode 1.19.5, MiniMax Code 0.7.4,
`mmx` 1.0.28 ve Freebuff 0.2.35. Qwen 0.26.5 ve Antigravity 1.4.12 resmi
güncel sürümle aynı. MiniMax Code'un çakışan eski launcher'ları yalnızca etkin
`mcode` süreci olmadığı doğrulandıktan sonra geçici klasöre yedeklendi; yeni
resmi paket çalışıyor. Eski launcher yedeği `%TEMP%` altında bırakıldı.
ZCode masaüstü 3.17.1; bundled CLI 0.17.1. Masaüstü güncellemesi CLI'ya Start
Plan model seçimini kazandırmadı.

- Antigravity kota modeli düzeltmesi `src/routing.js` içinde: model-scope
  `rate_limited` artık başka model ailesinin sıfır kotasıyla Gemini'yi bloklamaz.
  Havuzda aktif görev olmadığı doğrulandı, servis (1.8.4) yenilendi. Canlı RPC'de
  `gemini-3.8-flash` seçimi başarılı; okunan Gemini bakiyesi haftalık %88.8,
  5 saatlik %91.5. Claude/GPT aileleri sıfır. Kullanıcı isteğiyle Pool'dan küçük
  text çağrısı yapıldı; CLI doğru `gemini-3.8-flash-low` varyantını başlattı, ancak
  30 saniyede `TIMEOUT` verdi ve hata ayrıntısında `permission_mode: request-review`
  ile `--mode plan` uyarısı yer aldı. Gerçek yanıt alınmadı; Antigravity Gemini
  seçimi düzeldi, uçtan uca çağrı hâlâ doğrulanmadı. Otomatik tekrar yapılmadı.
  Devam incelemesinde CLI 1.4.12'nin slash genişletmesi kapalıyken `--mode plan`
  bayrağını yok saydığı doğrulandı. Metin görevleri artık oturumluk
  `agentMode: plan` kullanıyor; `request-review` ve deny kuralları değişmedi.
  Yeni kodla canlı Pool çağrısı `gemini-3.8-flash-low` üzerinden `succeeded` ve
  `OK` döndürdü; zaman aşımı, izin hatası veya `errorDetail` kalmadı.
- Codex 0.166.0 ile Pool text çağrısı gerçek yanıt verdi. MiniMax Code 0.7.4
  `free_credits` rotasıyla `MiniMax-M3.1-Flash` gerçek yanıtı verdi.
- OpenCode katalog düzeltmesi `src/adapters.js`: ilk 100 model kesilmeden önce
  sıfır maliyetli modeller öne alınıp korunuyor; regresyon testi eklendi. 12
  OpenRouter ücretsiz model Pool'da `billing: free` / auto-select olarak
  sınıflandı. `google/gemma-4-26b-a4b-it:free` ilk gerçek çağrıyı verdi; sonraki
  çağrı ortak upstream havuzdan 429 verdi. OpenCode'un kendi `beam-free` rotası
  geçersiz credential ile 401 verdi. Ücretli API fallback yapılmadı.
- Qwen 0.26.5 auth doğrulandı, fakat International Qwen Cloud Official kotası
  ayın 3'ündeki sıfırlanmaya kadar dolu; bu nedenle yeni inference denenmedi.
- Claude Pro girişi var; 5 saatlik pencere %100, 7 günlük pencere %0 ve 3 Kasım
  08:00 UTC'de sıfırlanıyor. Uygun canlı inference kotası olmadığından denenmedi.
- ZCode Lite planı `zcode-local` monitor/readback'inde görünüyor; haftalık
  pencere %0 ve 1 Kasım 17:31 UTC'de sıfırlanıyor. Kampanya `zai-start-plan` /
  `GLM-5.3-Flash`, CLI provider registry'de yok; Pool bu modeli seçip çalıştıramıyor.
  Kullanıcıya ait model tanımı var, secret okunmadı/kopyalanmadı. Upstream
  standalone app-server sınırı: https://github.com/zai-org/feedback/issues/1014 .
- `mmx` OAuth durumu var, ancak Token Plan yok ve plan kotası raporlanmıyor;
  bu `mcode` günlük free-credit rotasından ayrı. Ücretli çağrı/fallback yok.
- Freebuff 0.2.35 ve WorkBuddy MCP konfigürasyonlarındaki kayıtlı `command/args/env`
  ile iki ayrı MCP stdio istemcisi başlatıldı. Her ikisinde el sıkışma başarılı,
  11 tool listelendi, `pool_list_connections` 13 bağlantı döndürdü ve
  `pool_get_quotas(agy-local)` başarılı oldu (Gemini haftalık %88.8 / 5 saatlik
  %91.5; Claude/GPT %0). Böylece iki kayıtlı MCP istemci yolu ve canlı kota
  readback'i doğrulandı. Freebuff'un Google oturum/login akışı ayrıca tamamlandı
  diye doğrulanmadı; WorkBuddy masaüstü arayüzünden ayrı bir görev çalıştırılmadı.
  Kullanıcının isteğiyle Qoder Desktop kullanıcı MCP yapılandırmasına aynı
  credential-free `cli-agent-pool` stdio bağlantısı eklendi. Kayıt `applied`,
  sunucu `ready`; Qoder'ın `list_tools` readback'i 11 Pool aracını döndürdü.
  Aynı Qoder MCP bağlantısından `pool_get_quotas(agy-local)` çağrısı başarılı oldu;
  Gemini haftalık %19,64 / 5 saatlik %97,96 ve Claude/GPT haftalık %40,52 okundu.
  Qoder üzerinden ayrı bir model görevi çalıştırılmadı.

Son kod kontrolleri: `npm test` 108/108; `npm run check`, `npm run secrets`
(64 dosya) ve `npm audit` (0 açık) geçti. Antigravity ve OpenCode yeni regresyon
testleri dahil. Bu kanıt, yukarıdaki açık kota/plan/uygulama engellerini kapatmaz;
bakım planı öncelikli hesap hedeflerinin hepsini tamamlandı olarak işaretlemez.

## 1 Kasım 2026 — tüm bağlantılarda görünürlük ve güvenilirlik kontrolü

Kapsam yalnızca örnek verilen sağlayıcılar değil, 13 kayıtlı bağlantının tamamı:
katalog/havuz görünürlüğü, seçim politikası, adaptör izinleri ve hata protokolleri,
kota/oturum readback'i ve üç masaüstü MCP istemcisinin kayıtlı bağlantısı.

- [x] Kapalı bağlantıyı katalog sekmeleri, aile görünümü, havuz üyeleri ve havuz
  sayaçlarından çıkar. Ayarlar kaydı ve model üyelikleri yeniden açmak için korunsun;
  aynı modelin başka açık bağlantıdaki kopyası görünür kalsın.
- [x] Ücretsiz model etiketi açık `autoSelect:false` kararını aşmasın. Açıkça
  bağlantı seçimi ve belirtilmemiş otomatik seçim varsayılanı ayrı test edilsin.
- [x] MCP'nin düz metin doğrulama hatasını JSON.parse/SyntaxError yerine kararlı
  TOOL_FAILED olarak ilet; protokol metnindeki olası özel veriyi hata içine kopyalama.
- [x] 13 bağlantının tamamından güncel kota/oturum readback'i al; kapalı bağlantıları
  çalıştırma veya yeniden etkinleştirme. Ücretli fallback ve otomatik görev tekrarı yok.
- [x] Freebuff, WorkBuddy ve Qoder kayıtlı command/args üzerinden ayrı MCP stdio
  el sıkışması, 11 araç listesi ve canlı Antigravity kota sorgusu: üçü de başarılı.
- [x] 111/111 node:test; syntax, secrets (65 dosya), npm audit (0 açık).

Canlı readback (15:05–15:06 UTC): Codex kısa dönem %75 / haftalık %96;
Antigravity Gemini haftalık %19.17 / 5 saatlik %96.98, Claude/GPT haftalık
%40.52 / 5 saatlik %100. Claude haftalık %0 (3 Kasım 08:00 UTC), ZCode
haftalık %0 (1 Kasım 17:31:55 UTC). Qwen model-list girişi doğrulandı ama
kalan kota endpointte yok; önceki quota rejection hâlâ gerçek inference engeli
olabilir. MiniMax Code günlük/account credits bakiyesi bu API'de görünmüyor;
MMX OAuth var, etkin Token Plan yok. Kapalı Kimi oturum jetonu süresi dolmuş;
MiMo yalnızca credential varlığını bildiriyor. OpenCode/OpenRouter negatif bakiye
bildiriyor; bağlantı kullanıcı tarafından kapalı. OmniRoute/Hermes kota sunmuyor;
LM Studio yerel bağlantısında model yok. Bunlar başarılı inference kanıtı sayılmadı.
Önceki başarılı/başarısız görevler tekrar edilmedi; çağrı geçmişi korundu.

Gerçek tarayıcıda Codex Ayarlar'dan kapatılıp kaydedildi; katalog ve havuz
kartları sıfıra düştü, sayfa yenilenince kapalı kaldı. MiMo gibi önceden kapalı
bağlantılar da görünmüyor. Kontrol sonrası Codex eski açık durumuna geri alındı;
model ve havuz üyelikleri silinmez. Aktif/kuyrukta iş olmadığı doğrulanıp tanınan
Pool daemon'u yeni kodla yeniden başlatıldı; global npm paketi bu kaynak ağacına
junction olduğu için ikinci paket kopyası kurulmadı.

Qoder Desktop kurulu; ayrı `qoder`/`qodercli`/`coder` komutu PATH'te yok ve
Pool'da Qoder worker adaptörü yok. Desktop'un MCP istemcisi olması kendi
modellerini Pool worker yapmaz. Resmî günlük 100 Credits kampanyası desktop'ta
manuel claim gerektirir; claim edilmiş krediler aynı hesapla CLI'da da kullanılabilir:
https://docs.qoder.com/events/100credits . Hesaba ait claim/bakiye doğrulanmadı,
desktop credential'ı çıkarılmadı. Desteklenen CLI/model/izin sözleşmesi ayrıca
doğrulanmadan worker veya otomatik bakiye entegrasyonu varmış gibi sunulmadı.
Antigravity 1.4.12 metin modu oturumluk agentMode:plan düzeltmesi korundu;
önceki başarılı canlı yanıt kaydı ve izin/regresyon testleri yeniden incelendi.
Freebuff/WorkBuddy'nin kendi UI login'i ve uygulama içinden görev çalıştırması
bu MCP transport kontrolüyle tamamlandı sayılmaz. Commit/push yapılmadı.

## 1 Kasım 2026 — dış çalışma kopyalarının Antigravity izin onarımı

Kullanıcı PERMISSION_REQUIRED / RunCommand engelinin yerel olarak düzeltilmesini istedi.
Dört güncel izin hatası, aynı deponun kullanıcı dizinindeki Git worktree
klasörlerinde oluştu. Native proje resolver bu klasörler için boş dönüyor;
varsayılan proje komut izni sunmuyor. Mimari değişikliği gerekmiyor.

- [x] Yalnız ilgili depo ve ona ait dış workspaces kökü için native proje kaydı
  ve komut/dosya izinleri oluştur; global politikayı değiştirme.
- [x] Dört klasörün native proje eşlemesini ve bir yeni canlı komut probunu doğrula.
- [x] Eski needs_review işlerini tekrar çalıştırmadan koru; kanıtı kaydet.

Kanıt: Dört mevcut dış worktree yeni native proje ile eşleşti. İlgili depo
ve yalnız ona ait dış workspaces kökü proje kaynakları olarak kaydedildi;
komut ve dosya izinleri yerel native projede tutuldu. Genel CLI ayarları
değişmedi; skip-permissions kullanılmadı. Kurulu resolver kaynakla aynı;
yeni CLI süreçleri yerel kaydı okuyabildiği için daemon yeniden başlatılmadı.
Aynı başarısız çalışma dizininde yeni native komut probu başarılı; izin
hatası dönmedi. İlgili node:test kontrolleri 4/4 geçti. Eski needs_review
işleri ve çalışma kopyaları korundu; otomatik tekrar/merge yapılmadı.
Bu kapsamda ürün kodu değişmedi; makineye özgü izin kaydı Git dışında.

## 4 Kasım 2026 — Codex, Claude ve Antigravity çoklu hesap profilleri

Kullanıcı Codex, Claude ve Antigravity'de birden fazla hesabı bir kez girişle
havuzda aynı anda hazır tutmak istedi. Hesap seçimi ve kota eşiğinde devretme
çağıran sistemin işidir; havuz her hesabı ayrı bağlantı olarak kotası, modeli ve
eforuyla sunar. Windows agy tek Credential Manager kaydı (`gemini:antigravity`)
kullandığından ek Antigravity hesapları WSL'deki resmî Linux agy ile çalışır.

- [x] agy davranışı doğrulandı: Windows'ta sabit tek kayıt; WSL'de 1.5.0 logu
  "Using file-based token storage because WSL environment detected", giriş HOME'a bağlı.
- [x] Route alanları: `profile`, `runtime: wsl`, `wsl {distro, home}`; şema doğrulaması
  ve aynı profilin iki bağlantıda kullanılmasının reddi.
- [x] Codex/Claude: `CODEX_HOME` / `CLAUDE_CONFIG_DIR` ile çalıştırma, giriş kontrolü,
  katalog, kota ve giriş penceresi; varsayılan hesap davranışı değişmedi.
- [x] Antigravity WSL: kabuksuz `wsl.exe --exec env HOME=...`, profil token dosyasından
  bellek içi kota (Windows girişine geri düşmez), WSL proje eşleştirmesi.
- [x] Sahip eylemlerinde izin eşitleme (giriş, katalog yenileme, servis açılışı, düğme);
  görev gönderimi izin oluşturmaz, kimlik bilgisi kopyalanmaz.
- [x] UI: "Başka hesap ekle", "WSL ile başka Antigravity hesabı ekle", "Antigravity
  izinlerini eşitle"; MCP çıktısında `account`.
- [x] 133/133 node:test (10 yeni), check, secrets (77 dosya), audit 0 açık.
- [ ] Kullanıcı ek hesaplara giriş yaptıktan sonra her yeni bağlantıda kota readback
  ve kısa gerçek text çağrısı; WSL agy OAuth akışının tarayıcıda tamamlandığını doğrula.

Kanıt: Gerçek WSL'de geçici `pooltest` profili tespit edildi, 25 proje / 17 izin /
8 güvenilir klasör eşitlendi; izole agy "Please sign in" döndürdü ve kota
`auth_required` oldu (Windows hesabı sızmadı). Codex ve Claude için varsayılan
hesap giriş yapılmış kalırken profil `AUTH_REQUIRED` döndü. Test profilleri silindi.
WSL Ubuntu'ya resmî kurulum betiği (SHA512 doğrulamalı) ile agy 1.5.0 kuruldu.
`npm run setup` global kurulumu ve 42 skill dağıtımını tamamladı; aktif iş yokken
servis yeniden başlatıldı, kurulu `src` repo ile aynı, canlı MCP `account` alanını
döndürüyor. Commit/push yapılmadı.

### 4 Kasım 2026 (devam) — giriş önce, bağlantı sonra; ek CLI profilleri

Kullanıcı WSL giriş penceresinin anında kapandığını ve "hesap ekle"nin girişsiz
boş bağlantılar biriktirdiğini bildirdi; ZCode ve diğer CLI'lar için de hesap istedi.

- [x] Kök neden: giriş betiği her argümanı tırnaklıyordu; `wsl.exe` tırnaklı
  `"--exec"` seçeneğini tanımayıp 127 ile çıkıyordu. Artık yalnız boşluklu argüman tırnaklanır.
- [x] WSL'de `xdg-open` yok; profil hazırlığı Pool'a ait, yalnız https açan bir
  yardımcıyı kurar ve giriş penceresi PATH'e ekler (Windows varsayılan tarayıcısı).
- [x] "Başka hesapla giriş yap": önce resmî giriş terminali açılır, bağlantı yalnız
  CLI girişi algılayınca eklenir; tekrar denemeler aynı bekleyen profili kullanır.
  Girişsiz dört boş `agy-acc*` bağlantısı kaldırıldı.
- [x] Ev klasörü profilleri: ZCode, Qwen, Kimi, MiniMax Code, mmx, Qoder, MiMo
  (`USERPROFILE`/`HOME`). Her biri için boş profilde girişsiz, varsayılanda girişli
  canlı doğrulandı; kota/katalog/giriş kontrolü profil evini kullanır.
- [x] 136/136 node:test, check, secrets, audit 0 açık; kurulum ve servis yenilendi.
- [ ] Kullanıcının gerçek ek hesap girişleri sonrası kota readback ve kısa text çağrısı.


## 5 Kasım 2026 — Director mechanisms, pb-director/1

- [x] Read repo docs and sibling director contract; revise design to PB-owned relay.
- [x] Self-critique and independent reviewer: preflight and fingerprint gaps identified.
- [x] Profile/preflight/agy/lock and contract lifecycle implementation.
- [x] Isolated node:test and MCP contract validation; 157/157; check/secrets/audit (0 vulnerabilities).
- [x] Skill documentation, managed deployment and local install verification.
- [x] Commit, push and report evidence to lead (release completion is reported with the final commit ID in the lead chat).


Evidence: independent review accepted the mechanism-only architecture and fixes
for hidden-index edits, native read/token evidence, queued probe cleanup,
atomic task/hook registration and idempotent director replay. Isolated lifecycle
suite 9/9; all tests 157/157. Project Brain committed runnable cross-repo
`tools/test_relay_integration.mjs` (a6e09e5): real transport/watchdog, synthetic
native executor, scratch git/bare remote; preflight -> permission failure ->
onExit recover -> failover -> takeover/ack -> commit/push -> complete PASS.
No credential copies, native permission bypass or implicit paid fallback.

Local acceptance: global npm 2.2.0 installed, existing service replaced only with
0 active jobs; live MCP reports pb-director/1 and all eight features. Runtime
src/bin/web/skills content matches source (npm shebang newline normalized).
Skills Manager preserved the existing skill ID/source and 42 deployments;
SKILL.md plus operations.md match every deployed target by SHA-256. Desktop
and Start Menu shortcuts refreshed. Source rerun of the cross-repo integration
also PASS. No live vendor readiness is claimed by this synthetic-executor test.

## Antigravity: /usage kotası ve Windows izolasyon sınırı

- [x] Varsayılan hesap kotası `agy -p /usage --output-format json` ile okunur (haftalık/5 saatlik, yenilenme saati, Gemini 4 Argon); Cloud Code yedek.
- [x] Doğrulandı: Windows `agy` profil HOME'una, `ANTIGRAVITY_GEMINI_DIR`/`APP_DATA_DIR`/`EXECUTABLE_DATA_DIR`/`CREDENTIAL_SCOPE` ve `AGY_ACCOUNT` değişkenlerine bakmadan Credential Manager'daki tek girişi kullanır.
- [ ] Ek hesapların kimlik izolasyonu için WSL (dosya tabanlı token) yolu geri kazanılmalı.
