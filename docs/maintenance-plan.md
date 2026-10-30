# Devralma ve düzeltme planı — 19 Ekim 2026

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
Başlangıç/yayın skill'lerinin önerisi [ayrı tasarım belgesinde](lifecycle-protocols.md).

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

30 Ekim 2026: Ayarlar ekranina Seri (1) ve Paralel (2-8) gorev siniri secimi eklendi;
mevcut `concurrency` konfigurasyon alani kullaniliyor. Gercek havuz admission testi
ayri workspace'lerde seri/paralel sinirlarini, preference testi yalnizca secilen
ayari kaydederken diger taslaklari korumayi dogrular. Ayni/ic ice workspace kilidi
degistirilmedi.
