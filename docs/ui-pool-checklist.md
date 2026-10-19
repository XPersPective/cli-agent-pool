# Havuz ve çalışma alanı kabul listesi

Güncel arayüz: Pool 1.4.0. Önceki sayfalama, kapalı kota ve ayar penceresi düzeninin yerini aşağıdaki davranışlar alır.

- [x] Yüksek / Orta / Hafif havuzları; sağlayıcılar ayrı katalog sekmeleri.
- [x] Küçük Ekle düğmesiyle hedef havuz ve bağımsız efor seçimi; üst havuz görünümü değişmez.
- [x] Aynı üyeliği tekrar eklemek mevcut eforu korur; açıkça seçilen yeni efor uygulanır.
- [x] Model seçimi: Ajan seçsin / Havuzlarım; sabit efor ve aynı havuzda kota alternatifi korunur.
- [x] Tam model kimlikleri ve bildirilen sürümler; bilinmeyen sürüm/kota tahmin edilmez.
- [x] Kotalar varsayılan açık; topluca veya tek tek aç/kapat; yenilemede açık durum ve kaydırma korunur.
- [x] Büyük kalan yüzde, kalan miktarı gösteren çubuk, kullanılan yüzde, pencere ve yenilenme bilgisi.
- [x] Sayfalamasız katalog; en son modele kadar yerel kaydırma; daraltılmış üst alan.
- [x] Seçili havuzda vurgu; diğerlerinde temaya uygun nötr görünüm; Türkçe efor etiketleri.
- [x] Ayrı Ayarlar sayfası; kapalı başlayan bağlantılar, ekleme formları ve keşif/kota araçları.
- [x] JSON yerine okunabilir kota ayrıntısı; değişiklik varsa Kaydet / Vazgeç, yoksa Kaydedildi.
- [x] Kaydetmeden tarama; taslak üyelikler, eforlar ve keşfedilen modeller korunur.
- [x] Projeler Çalışma Alanı içinde; başlangıçta kurulum klasörü seçilmez; ham kök klasör listesi yok.
- [x] Windows yerel klasör seçicisi; iptal ve Unicode desteği; proje listesi ve görev geçmişi.
- [x] Mikrofon/gönder düğmeleri, skill ve hedef talimatları; görevde model/efor/kapsam bilgisi.
- [x] Klavye ve erişilebilir adlar; açık/koyu/sistem teması; 1440×1000, 1280×720, 390×844 düzenleri.
- [x] MCP/JSON ajan API'si; sahip politikası, otomatik başlatma ve bağımsız Project Brain bağlantısı.

46 node:test kontrolü, sözdizimi, gizli bilgi taraması ve bağımlılık denetimi başarılı.
Tarayıcı kontrolleri: kota anahtarları, kaydırma, son model, tekrar ekleme, taslak kaydet/vazgeç,
ayar sayfası, okunabilir kota, 24 üzeri modelin sayfasız görünmesi, açık proje seçimi ve görev sonucu.
Önceki doğrulamalar: gerçek Windows klasör seçimi/iptali ve taklit SpeechRecognition olaylarıyla
konuşma/izin/hata akışları. Gerçek mikrofon donanımıyla konuşma tanıma doğrulanmadı.

Kota bildirilmeyen sağlayıcıda yüzde uydurulmaz. Ortak hesap kotası ayrı model bakiyesi gibi
sunulmaz. Yerel CLI bulunması kurulu model anlamına gelmez; LM Studio/Ollama kataloğu okunur.

1.3.0 ek kontrolleri:
- [x] Tam model / bağlantı / aile filtresi, kaydetme ve geri gösterme; taramada ve ajan seçiminde engel.
- [x] Araç/aile görünümü, A–Z/Z–A sıralama, farklı abonelikten aynı modelin bağımsız üyeliği.
- [x] Havuz ve katalog aç/kapat kalıcılığı; tüm kartlarda ortak kota anahtarı ve ince çubuklar.
- [x] Havuzlarım için ayrı zemin/çerçeve; görünür klavye odağı ve bağlantı bazında erişilebilir işlem adları.
- [x] Giriş gerekli uyarısı; resmî CLI girişini açma ve önbelleksiz kontrol. Windows terminali sentetik CLI ile gerçekten açıldı; kullanıcı hesabıyla giriş yapılmadı.
- [x] Manuel modda dolu ilk havuz, boş havuz açıklaması, proje seçimi sonrası başarılı sohbet gönderimi.
- [x] 390→1440 ve 900→2560 genişliklerine dönüş; taşma yok, önceki genişlik geri geliyor. Yakınlaştırılmış CSS düzeninde de taşma kontrolü.

Antigravity vendor-labelled quota windows are scoped to Gemini or Claude/GPT models; unrelated exhausted windows do not block other families. Unknown percentages stay unknown.

1.4.0 kontrolleri: eşleşen havuz/katalog kartları, normal ağırlıkta kota metni, iki satıra
sarılan sekmeler, yan yana menüler, yumuşak koyu tema, görünür artı ve yanındaki proje,
altta sabit giriş, sade mesajlar, yeniden açılışta izinli proje/geçmiş, proje/kütüphane
skill seçimi ve / kısayolu. Yeni skill okuma sınırları node:test ile doğrulanır.
Gerçek Hafif havuz/Luna denemesi önce eksik Windows sandbox seçimini ortaya çıkardı;
native backend açıkça seçildikten sonra gerçek dosya yazımı doğrulandı. Test projesi,
istemler ve sonuçlar depo dışında tutulur; sentetik ve gerçek model testleri ayrı raporlanır.
