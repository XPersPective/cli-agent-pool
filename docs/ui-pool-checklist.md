# Havuz ve çalışma alanı kabul listesi

Güncel arayüz: Pool 1.2.0. Önceki sayfalama, kapalı kota ve ayar penceresi düzeninin yerini aşağıdaki davranışlar alır.

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

39 node:test kontrolü, sözdizimi, gizli bilgi taraması ve bağımlılık denetimi başarılı.
Tarayıcı kontrolleri: kota anahtarları, kaydırma, son model, tekrar ekleme, taslak kaydet/vazgeç,
ayar sayfası, okunabilir kota, 24 üzeri modelin sayfasız görünmesi, açık proje seçimi ve görev sonucu.
Önceki doğrulamalar: gerçek Windows klasör seçimi/iptali ve taklit SpeechRecognition olaylarıyla
konuşma/izin/hata akışları. Gerçek mikrofon donanımıyla konuşma tanıma doğrulanmadı.

Kota bildirilmeyen sağlayıcıda yüzde uydurulmaz. Ortak hesap kotası ayrı model bakiyesi gibi
sunulmaz. Yerel CLI bulunması kurulu model anlamına gelmez; LM Studio/Ollama kataloğu okunur.
