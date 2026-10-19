# Devralma ve düzeltme planı — 19 Ekim 2026

Bu dosya kullanıcının birikmiş taleplerinin uygulanabilir iş listesidir. İşaretlenmemiş
işler tamamlanmış sayılmaz. Üretim sürümü başlangıç noktası: **1.4.3**, commit
`368faf13e8770a992ea7925c08eb9c93787d202f`. Bu belge bir sürüm veya test başarı iddiası değildir.

## Çalışma kararı

Pool geliştirmesi Project Brain veya Store Automation çalışma akışına bağlanmayacak.
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
