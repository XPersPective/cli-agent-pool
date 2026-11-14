# CLI Agent Pool — Bakım Planı ve Kanıt Kaydı

## Kalıcı Mimari Kurallar (Değişmezler)
- Bağımsız yerel servis (`127.0.0.1:43127`, tek kullanımlık dashboard token + `HttpOnly`/`SameSite=Strict` çerez). DeepSeek Harness, Hermes veya Project Brain bağımlılığı yoktur.
- Resmî CLI oturumu yeniden kullanılır; kimlik bilgisi kopyalanmaz, CLI dosya/aracı izinleri atlanmaz ve `paid_api` otomatik fallback olarak açılmaz.
- Çalışma durumu repo dışında yerel uygulama veri dizininde tutulur.
- Tüm süreç çağrıları shell-free yapılır (`runProcess` + `supervisor.py` Job Object / process group, arka planda `CREATE_NO_WINDOW` / `SW_HIDE`, yalnız resmî `openCliLogin` görünür pencere açar).
- UI-only `"Tümünü Göster"` (`__all__`) ve `all` hiçbir zaman dış `/api/pools` veya MCP havuzu olarak verilmez (`isCategoryId`).

## Önceki Sürümler Özeti (1.0.0 – 2.5.0)
- [x] **1.0.0–1.9.x**: `cli-agent-pool` bağımsız yerel havuz çekirdeği, native Codex/Claude/OpenCode/ZCode/Qwen/MiniMax/Kimi/MiMo/Qoder/Antigravity adaptörleri, kendi kota katmanı (`src/quotas.js`), izolasyonlu `Pool` seçici ve `modelFilters` gizleme kuralları.
- [x] **2.0.0–2.1.1**: Kategori/katalog sözleşmesi (keyfi özel kategoriler, eski seçim/yetki modlarının migrasyonla kaldırılması), global/per-route worker tavanlarının kaldırılması (128 eşzamanlı görev doğrulandı), çağrı geçmişinin 7 gün / 500 kayıt ile sınırlandırılması ve `delete_task`.
- [x] **2.2.0**: Çoklu hesap profilleri (`USERPROFILE`/`HOME` izolasyonu, `finish_account` kopya e-posta reddi, Antigravity izin eşitleme), Argon (`gemini-4-argon`) kota grubu ve `pb-director/1` gözetim/preflight mekanizmaları.
- [x] **2.5.0**: Windows `.acl-hardened` önbelleklemesi (~59.9s → ~0.49s CLI açılışı), gereksiz MCP tarama atlama, doğrudan `/api/*` okuma uç noktaları, `pool_quota_overview`, `cli-agent-pool quotas|model|api` ve `light-dark()` tabanlı koyu-öncelikli arayüz (`166/166` test, `check`/`secrets`/`audit` 0 açık).

## Açık Kalan Dış / Canlı Doğrulama Maddeleri
- [ ] Ek Antigravity hesaplarının Windows dışında tam kimlik izolasyonu için WSL dosya-tabanlı token yolunun kullanıcı oturumlarıyla yeniden doğrulanması.
- [ ] Gerçek çoklu hesap (`codex`, `claude`, `agy`, `zcode`, `qwen`, `mmx`, `mcode`, `opencode`) canlı girişleri sonrası kullanıcı ortamında tekil model çağrısı / kota readback doğrulaması (bu havuz dış hesap kimliği saklamadan yalnızca resmî CLI oturumu varsa okur).

## 2.6.0 — Sıralama, E-posta Görünürlüğü, Sorun Vurgusu, Gizlenenler ve Güvenli Kontrol
- [x] **Windows arka plan terminal gizleme**: `src/process.js` (`windowsHide`), `src/supervisor.py` (`CREATE_NO_WINDOW` + `STARTF_USESHOWWINDOW`/`SW_HIDE`) ve `src/preflight.js` (`windowsHide: true`) ile arka plan süreçlerinde konsol penceresi açılması engellendi (`openCliLogin` resmî giriş terminalini görünür tutar).
- [x] **Yalnızca UI "Tümünü Göster" (`__all__`) ve `isCategoryId` koruması**: Havuzlarım içinde tüm havuz üyelerini tek ekranda görüntüleme, filtreleme, toplu devre dışı bırakma/gizleme; `/api/pools` ve `isCategoryId` `all`/`__all__` kabul etmez.
- [x] **Çok boyutlu sıralama + elle `order` sırası**: `src/config.js`, `src/pool.js`, `web/pool-state.js` ve `web/app.js` içinde `az`, `za`, `manual` (`↑`/`↓` ve tutamaçlı sürükle-bırak kalıcı `order`/`member.order`), `family` (`Argon` dahil), `provider`, `email`, `quota_desc`, `quota_asc`, `quota_5h`, `quota_weekly`, `category`, `status`; `Pool.select` eşit durumda manuel `order` önceliği uygular.
- [x] **E-posta vurgusu ve iki tonlu sorun kartları**: Kartlarda kesilmeyen tam `.model-email-badge`, kırmızı `.is-issue-error` (giriş/abonelik/kota %0) ve amber `.is-issue-unknown` (kota okunamayan) durumları WCAG uyumlu açık metin rozetleriyle ayrıldı; tek tık **Devre dışı bırak / Etkinleştir** ve **Kapalıları da göster** düğmesi eklendi.
- [x] **Kategorize Gizlenenler + Tek Tık Güncelle / Güvenli Çıkış**: `modelFilters` `reason` alanı, `#hidden-area` paneli (neden/aile/araç/e-posta filtreleri + `unhideModels` ile kural bölerek tekil/grup geri yükleme), üst çubuk/Ayarlar **Güncelle** (`update_service`) ve **Güvenli çıkış** (`shutdown` + `cli-agent-pool stop`).
- [x] **Doğrulama kanıtı (2.6.0)**: `npm run check` (`JavaScript syntax checks passed`), `npm run secrets` (`90 dosya temiz`), `npm audit --audit-level=moderate` (`0 vulnerabilities`), `npm test` (`169/169` geçti, `0` başarısız / atlanan). Canlı kurulum/Chrome doğrulaması yayın adımında yürütüldü.
