# Başlangıç → geliştirme → yayın: bağımsız protokol önerisi

19 Ekim 2026. İlk tasarım ve sonraki uygulama kaydıdır. Project Forge ve Release Harbor ayrı
özel depolarda uygulandı; otomatik mağaza yayını veya genel Brain değişikliği yapılmadı. Mevcut bakım işleri [maintenance-plan.md](maintenance-plan.md) içindedir.

## Sorumluluk sınırı

```text
İsteğe bağlı başlangıç skill'i ── uygulama profili + başlangıç kanıtı ─┐
Kullanıcının ürün hedefi ────────────────────────────────────────────┤
                                                                  ▼
                                  Genel Project Brain + CLI Agent Pool
                                               │
                                  doğrulanmış geliştirme çıktısı
                                               │ kullanıcı yayını ister
                                               ▼
                                  Ayrı yayın hazırlama/yayın skill'i
                                               │
                             mağaza adaptörü / Fastlane / resmî Store API
```

Brain genel geliştirme ve proje hafızası olarak kalır. Kullanıcının oturumda verdiği
protokol, o projenin talimatı ve plan girdisidir; Brain skill'inin kendi dosyası veya
genel varsayılanı değişmez. Başka bir JavaScript/kütüphane/masaüstü projesi bu iki
opsiyonel skill olmadan aynı Brain ile çalışır. Yeni framework/merkezî orkestratör
yazmak gerekmiyor: iki bağımsız skill ve projeye ait küçük bir profil yeterli.

## 1. Başlangıç skill'i

Uygulanan ad: `project-forge`. Mevcut
`D:/repositories/napp_app_template/tool/new_app.dart` üreticisini kullanır. Template
deposuna uygulama yazmaz; yeni hedefte üretir. Kaynak README'sinin mevcut güvenlik
ve parametre sözleşmesini değiştirmeden kullanır.

Önce ürün hedefini ve mevcut profili okur; sadece eksik/çelişkili kararı sorar:

- Uygulama kimliği ve hedef platform/diller, veri modeli ve uygulama hedefi.
- Reklam kapalı/açık; banner, rewarded, app-open ve gerçek doğal duraklamaya bağlı
  interstitial tercihi. Her uygulamanın ayrı reklam uygulama/birim kimlikleri.
- Ücretsiz/tek seferlik/abonelik; ürün SKU'ları, doğrulama backend'i, restore ve
  entitlement davranışı. Örnek reklam veya satın alma kimliğiyle üretim hazır denmez.
- Destek/gizlilik/şartlar, marka/ikon ve yayıncı profili.

Template ve core/pro/ads sürümleri ayrı sabitlenir; yeni template güncellemesi
mevcut uygulamaya otomatik uygulanmaz. Önce dry-run/önizleme, sonra yeni kopyada
üretim, test ve ürün hedefiyle birlikte Brain'e devir. Başlangıç işi bittiğinde
derleme/test sonucu ve geriye kalan gerçek blokajlar yazılır.

## 2. Projeye ait tek bilgi kaynağı

Öneri: `app-profile.json` ve `release/` altında okunabilir raporlar. Profil küçük,
sürüm numaralı ve şema doğrulamalı olur. Skill paketleri uygulamaya ait kimlikleri
veya özel anahtarları içinde taşımaz. Değişmeyen yayıncı bilgisi ayrı yerel profilde;
uygulama bazlı değerler ayrı uygulama profilinde tutulur.

| Bilgi | Saklama ve davranış |
| --- | --- |
| Ürün hedefi, platform, package/bundle kimliği, reklam seçimi, SKU'lar | Uygulama profili; gizli olmayan değerler sürümlenebilir. |
| Template/kit sürümleri ve protokol sürümü | Tam sürüm/commit; devralan ajan aynı girdileri bulur. |
| Reklam/store uygulama kimlikleri ve doğrulama durumu | Uygulama başına; başka uygulamadan kopyalanmaz. |
| Google servis hesabı, Apple `.p8`, signing key/parola | Repo dışı secret dosyası/keychain/CI secret; profilde yalnızca referansı. |
| Test/build/store kayıtları | Commit, build, checksum, hedef hesap/uygulama ve sonuç kanıtı; secret içermez. |

Tek bir dosyaya bütün gizli anahtarları gömmek yerine dosya konumuna referans
koymak aynı kolaylığı daha az sızıntı riskiyle sağlar. Eksikse "şu credential türünü
şu yerel dosyaya koyun; şu yetki gerekiyor" şeklinde tek, toplu eksikler raporu
verilir. Doğrulamadan kimlik uydurulmaz; API destekliyorsa yetkili hesapta mevcut
kayıt aranır, yoksa kullanıcı isteği kapsamında oluşturulur ve profil güncellenir.

Kaynak protokol değiştiğinde mevcut projenin kayıtlı sürümü sessizce değişmez.
Yeni sürüm benimsenirse fark ve gerekiyorsa migration açıkça kaydedilir.

## 3. Genel Brain'e oturumda devir

Örnek istek: "Bu başlangıç protokolünü ve app-profile.json'u oku; ürün hedefi X.
Bu projede bu girdileri kullan." Başlangıç skill'i kendi çıktı yolunu verir;
Brain bu projenin planına hedefleri, kısıtları ve kanıt bağlantılarını alır.
Kalıcı olan proje kararıdır, Brain çekirdeğinde Flutter'a özel kod değildir.

Pool bağlantısındaki uyumluluk da sürümle doğrulanır: geliştirme sırasında kullanılan
Brain sabit kalır; Brain kaynak değişikliği gerekiyorsa ayrı fixture ve süreçte test
edilir, sonra yayımlanır. Test kendi çalıştırdığı skill dosyasını ortasında güncellemez.

## 4. Ayrı yayın skill'i

Uygulanan ad: `release-harbor`. Kullanıcı "yayına hazırla/yayınla; bu protokolü
kullan" dediğinde çalışır. Başlangıç skill'i kullanılmış olması şart değildir;
mevcut Flutter/Android/iOS/Windows projesinden profili keşfedebilir, eksikleri sorar.

Akış:

1. Uygulamayı/hesabı/hedef mağazayı ve build'i kesinleştir. Profil, gerçek native
   package/bundle kimliği ve mağaza kaydı uyuşmazsa dur; yanlış uygulamaya yayın yok.
2. Önce prepare/check: test, imza, sürüm, izinler, gizlilik ve veri açıklamaları,
   satın alma/reklam doğruluğu, release build ve artifact checksum'u.
3. Mağaza bulunabilirliği için ASO: ürünün gerçek yeteneklerinden isim/alt başlık/
   açıklama, dil bazlı anahtar kelime ve kategori; tarihli rakip araştırması.
   İndirme/sıralama garantisi verilmez. Rakip marka/metin/görseli kopyalanmaz.
4. Gerçek build'den platforma uygun ekran görüntüleri; ikon/feature graphic,
   yerelleştirme ve okunaklı görsel önizleme. Olmayan özellik görselde gösterilmez.
5. Önce test kanalı (ör. internal/TestFlight) veya kullanıcının açıkça seçtiği
   hedef. Upload, incelemeye gönderme ve herkese yayınlama ayrı kaydedilir.
   Kullanıcı yayını zaten yetkilendirmişse gereksiz tekrar izin sorulmaz; fakat
   "hazırla" isteği kendiliğinden herkese yayınlama isteği sayılmaz.
6. CLI başarılı çıktı verdi diye bitirme: uzaktaki submission/build kimliğini,
   inceleme/dağıtım durumunu doğrula. Sonraki oturum kayıttan devam etsin;
   belirsiz sonucu körlemesine yeniden yükleme.

İlk uyarlama, `store-publish-matic` içindeki mevcut Fastlane runner/preflight ve
metadata bileşenlerinin sözleşmelerini incelemeli. Masaüstü UI'si var diye headless
arayüzü varmış gibi davranılmamalı. Kararlı API/CLI yoksa önce mevcut Fastlane
lane'lerini saran en küçük script; tüm masaüstü uygulamasını yeniden yazmak yok.

Fastlane Android/iOS için uygun mevcut yürütücüdür. Windows Store için paket türüne
göre Microsoft resmî submission yolu ayrı adaptör olur; Fastlane tek başına bütün
mağazaları kapsıyor denmez. iOS derleme için macOS/Xcode çalıştırıcısı gerekir;
Windows'taki bir skill bunu bir metin talimatıyla ortadan kaldıramaz.

## 5. Bitti ölçütü ve ayrı oturumun ilk işleri

- Skill'ler bağımsız çağrılabilir; birlikte ve Brain ile aynı profil üzerinde çalışır.
- Eksik girdi, yanlış uygulama kimliği, credential eksikliği ve eski protokol
  sürümü, tekrar çağrı ve kesilen upload senaryoları için küçük runnable testler.
- Örnek profilde secret veya gerçek hesap kimliği yok; çalışma verisi ayrı kalır.
- İki farklı uygulama aynı yayıncı kimliğini kullanırken reklam/SKU/signing/store
  kimlikleri birbirine geçmez; bir Flutter ve bir Flutter dışı proje ile test edilir.
- İlk gerçek yayından önce dry-run + sandbox/test kanalı kanıtı elde edilir.
- Sonraki kullanıcı isteğiyle iki skill ayrı depolarda oluşturuldu. Gerçek mağaza
  yayını, yeni reklam/mağaza hesabı veya uygulama kaydı bu geliştirme testlerinde açılmadı.

## Başvuru kaynakları

- Yerel `napp_app_template/README.md`: mevcut üretici seçenekleri ve üretim blokajları.
- Yerel `store-publish-matic/README.md`: mevcut Fastlane ve yayıncı eşleme kapsamı.
- [Fastlane Android setup](https://docs.fastlane.tools/getting-started/android/setup/)
  ve [Play Store action](https://docs.fastlane.tools/actions/upload_to_play_store/).
- [Fastlane App Store Connect API](https://docs.fastlane.tools/app-store-connect-api/).
- [Flutter iOS build/release](https://docs.flutter.dev/deployment/ios): macOS/Xcode gereksinimi.
- [Microsoft Store EXE/MSI submission API](https://learn.microsoft.com/en-us/windows/apps/publish/store-submission-api).
  MSIX/UWP gibi farklı paket türlerinde ilgili resmî sözleşme ayrıca doğrulanır.

Kaynaklar 19 Ekim 2026 incelemesinde kontrol edildi. Yayın günü mağaza kuralları ve
API sürümleri yeniden doğrulanacak; sabit bir "2026 kuralları" listesi sonsuza kadar
doğru sayılmayacak.
