# Gerektiğinde hata başvurusu

İlk tercih: pool_help {code:"KOD"}. Canlı giriş/kota: pool_get_quotas {routeId}.
Hatanın/task ID'sini koruyun; normal sorgularda bütün bu dosyayı yüklemeyin.

| Kod | Sonraki adım |
| --- | --- |
| AUTH_REQUIRED | İlgili resmî CLI girişini tamamlayın; quota/status ile yeniden kontrol edin. |
| MODEL_UNAVAILABLE | Native CLI model/hesabı yükleyemedi; katalog ve CLI hesabını kontrol edin. Başka plan otomatik kullanılmaz. |
| CATEGORY_NOT_FOUND | pool_list_pools ile güncel ID alın; katalog seçimi category gerektirmez. |
| NO_ROUTE | Tam model/route veya kategori, etkinlik ve kota durumunu kontrol edin. |
| PERMISSION_REQUIRED | Native CLI denied tool ve workspace izinlerini inceleyin. Bypass yok. |
| QUOTA_EXHAUSTED | Reset/bakiye beklenir; başka model yalnız çağıranın talimatı izin veriyorsa seçilir. |
| CREDITS_REQUIRED / SUBSCRIPTION_REQUIRED | Satıcı hesabı kredi/plan gerektiriyor; ücretli API fallback açılmaz. |
| BILLING_UNCONFIRMED / SETTINGS_NOT_TRUSTED | Sahibi UI bağlantı/native plan ayarlarını doğrular. |
| INVALID_REQUEST | Araç şeması, alanlar, desteklenen kind/effort kontrol edilir. |
| IDEMPOTENCY_CONFLICT | Anahtar farklı içerikte kullanılmış; eski göreve dönün veya yeni görev için yeni anahtar seçin. |
| WORKSPACE_REVIEW_REQUIRED / WORK_INCOMPLETE | Önce task raporu ve gerçek dosyalar incelenir. |
| INVALID_REPORT | Çıktı/dosyaları inceleyin; rapor formatını düzeltmek için işi yeniden koşturmayın. |
| CONFIG_CONFLICT | Owner UI güncel revizyonu alıp kendi değişikliğini yeniden uygular. |
| TIMEOUT / CANCELLED | Mevcut task incelenir; started write otomatik tekrarlanmaz. |

İncelenmiş durmuş görev için sahibi cli-agent-pool resolve <task-id> --note
ile kilidi kaldırabilir. Diğer projelerin karantinaları kaldırılmaz. Gizlenen,
kapalı ve dışarı sunulmayan modellerin erişimi bu hata yollarıyla açılmaz.
