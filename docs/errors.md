# Gerektiğinde hata başvurusu

İlk tercih: pool_help {code:"KOD"}. Canlı giriş/kota: pool_get_quotas {routeId}.
Hatanın/task ID'sini koruyun; normal sorgularda bütün bu dosyayı yüklemeyin.

| Kod | Sonraki adım |
| --- | --- |
| AUTH_REQUIRED | İlgili resmî CLI girişini tamamlayın; quota/status ile yeniden kontrol edin. |
| MODEL_UNAVAILABLE | Native CLI model/hesabı yükleyemedi; katalog ve CLI hesabını kontrol edin. Başka plan otomatik kullanılmaz. |
| CATEGORY_NOT_FOUND | pool_list_pools ile güncel ID alın; dış ajanlar yalnızca tanımlı kategorilerdeki modelleri kullanabilir. |
| MODEL_NOT_IN_POOL | İstenen model hiçbir havuz kategorisinde değil (veya seçilen kategoride yok); `pool_list_pools` ile havuz modelini seçin ya da sahibinden UI üzerinden havuza eklemesini isteyin. |
| NO_ROUTE | Tam model/route veya kategori, etkinlik ve kota durumunu kontrol edin. |
| PERMISSION_REQUIRED | Native CLI denied tool ve workspace izinlerini inceleyin. Bypass yok. |
| QUOTA_EXHAUSTED | Reset/bakiye beklenir; başka model yalnız çağıranın talimatı izin veriyorsa seçilir. |
| CREDITS_REQUIRED / SUBSCRIPTION_REQUIRED | Satıcı hesabı kredi/plan gerektiriyor; ücretli API fallback açılmaz. |
| BILLING_UNCONFIRMED / SETTINGS_NOT_TRUSTED | Sahibi UI bağlantı/native plan ayarlarını doğrular. |
| INVALID_REQUEST | Araç şeması, alanlar, desteklenen kind/effort kontrol edilir. |
| IDEMPOTENCY_CONFLICT | Anahtar farklı içerikte kullanılmış; eski göreve dönün veya yeni görev için yeni anahtar seçin. |
| MODEL_NOT_FOUND / ROUTE_DISABLED | İstenen model/rota katalogda yok veya kapalı; `pool_catalog` / `pool_list_connections` ile güncel durumu kontrol edin. |
| WORK_INCOMPLETE | Önce task raporu ve gerçek dosyalar incelenir. |
| INVALID_REPORT | Çıktı/dosyaları inceleyin; rapor formatını düzeltmek için işi yeniden koşturmayın. |
| CONFIG_CONFLICT | Owner UI güncel revizyonu alıp kendi değişikliğini yeniden uygular. |
| TIMEOUT / CANCELLED / INTERRUPTED | Mevcut task ve dosya değişiklikleri incelenir; started write otomatik tekrarlanmaz. |
| NETWORK_UNAVAILABLE / PROVIDER_OVERLOADED | Geçici ağ/sağlayıcı hatası; kısa bekleme sonrası yeniden deneyin veya başka sağlayıcı seçin. |
| OWNER_ONLY / PAID_ROUTE_DENIED / WORKSPACE_DENIED | Yetki, ücretli rota veya çalışma klasörü sınırını kontrol edin. |
| PREFLIGHT_REQUIRED / PREFLIGHT_FAILED / PREFLIGHT_EXPIRED | Director öncesi `cli-agent-pool preflight` çalıştırıp başarısız yetenekleri düzeltin. |
| QUOTA_BARRIER / SUPERSEDED_BY_HANDOFF | Director kota bariyeri veya halef devralması ile durduruldu; görevi ve kotayı inceleyin. |

CLI Agent Pool çalışma klasörü kilidi veya karantina (`needs_review`) uygulamaz;
eşzamanlı yazma koordinasyonu çağıran orkestratöre aittir. Eski kayıtlar için
`cli-agent-pool resolve <task-id> --note` uyumluluk amacıyla durur. Gizlenen,
kapalı ve dışarı sunulmayan modellerin erişimi bu hata yollarıyla açılmaz.
