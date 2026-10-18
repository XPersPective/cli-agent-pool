# Havuz ve çalışma alanı kabul listesi

- [x] Üç ana havuz: Yüksek / Orta / Hafif; sağlayıcılar alt katalog sekmeleri.
- [x] Seçili havuza model ekleme ve çıkarma; aynı model farklı havuzlarda bulunabilir.
- [x] Her havuz üyeliğinde bağımsız efor; sahibi sabitlediyse istemci değiştiremez.
- [x] Manuel seçimde havuz dışına çıkılmaz; otomatik seçim açıkça yapılandırılır.
- [x] Kota tükenince başlamamış yeni iş için aynı havuzdan alternatif seçilir.
- [x] Claude dahil canlı sürüm kataloğu ve tam model kimlikleri; tahminî sürüm yok.
- [x] Görev ayrıntısında seçilen model, efor, havuz ve varsa aracın bildirdiği model.
- [x] Model satırında kullanım/kalan yüzdesi, ortak kota kapsamı ve ölçüm/yenilenme bilgisi.
- [x] Kaydetmeden tarama; taslak üyelikler, eforlar ve yeni modeller korunur.
- [x] Windows yerel klasör seçicisi; iptal, Unicode ve mevcut proje koruması.
- [x] Proje listesi ve görev geçmişi; bağımsız görev çalıştırma.
- [x] Giriş kutusu içinde mikrofon/gönder düğmeleri; skill ve hedef talimatları.
- [x] Bağlantı ayarları üstten açılır; masaüstünde sayfa boyu kaydırma gerekmez.
- [x] Klavye, odak, erişilebilir adlar, dar ekran, karanlık tema ve hata durumları.
- [x] MCP keşfi/politika/üyelik/efor ve kota filtreleri; açık hata kodları ve örnekler.
- [x] node:test, sözdizimi, gizli bilgi taraması, npm audit ve gerçek arayüz doğrulaması.
- [x] Kurulu masaüstü kopyasını güncelleme ve gerçek katalogla son kontrol.

Doğrulanan arayüz akışları: üç havuza üyelik ve efor ekleme, aynı modelin farklı
havuzları, kaydetmeden tarama, ayar penceresi, skill/hedefli görev, sonuç ve model/efor,
Enter/Shift+Enter, dikte olayları, mikrofon izin hatası ve destek yokluğu, koyu tema,
1440×1000 / 1280×720 masaüstünde belge taşması olmaması ve 390 pikselde yatay taşma olmaması.
Windows modern klasör penceresi gerçek işletim sisteminde açıldı; seçim ve iptal sonucu
doğrulandı. Gerçek mikrofonla donanım/konuşma servisi testi yapılmadı; SpeechRecognition
olayları taklit edilerek giriş davranışı ve hata akışları doğrulandı.

Ajan auto-start kontrolü kapalı bağlantıları açmaz ve trustedSettings onayı vermez.
Kota bildirilmeyen sağlayıcılarda yüzde uydurulmaz. Yerel CLI bulunması tek başına
kurulu model olduğu anlamına gelmez; LM Studio / Ollama gerçek katalogdan okunur.

Son kontrol: 35 node:test başarılı; npm run check ve npm run secrets başarılı; npm audit açık bulmadı. Kurulu kopyada 13 araç sekmesi, Claude’un dört tam sürüm kimliği ve gerçek kullanım pencereleri doğrulandı; tarayıcı konsol hatası yok.

- [x] Son kullanıcı düzeltmesi: geniş açılan satırlar yerine sıkı model ızgarası; 1440 px ekranda dört sütun ve yaklaşık 16 görünür model, sayfa başına 24 kayıt, katalog içinde dikey kaydırma, tek satır yatay araç sekmeleri ve kapalı başlayan kota ayrıntıları.

- [x] Son düzeltme (1.1.1): küçük Ekle düğmesi → hedef havuz/efor penceresi; üst havuz görünümü değişmez, diğer üyelik/eforlar korunur. Açık / Koyu / Sistem teması ve tarayıcıda kalıcılık doğrulandı.
