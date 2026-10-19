# Ajan bağlantısı ve havuz seçimi

Standart MCP kullanın: `cli-agent-pool stdio` mevcut yerel servise bağlanır ve kapalıysa
başlatır. Sağlayıcı tokenı, hesap kimliği veya yönetim anahtarı istemciye kopyalanmaz.
HTTP taşıması gerekiyorsa adres `http://127.0.0.1:43127/mcp` (Streamable HTTP).

## En kısa görev akışı

1. `pool_list_pools {}`: üç havuz, tam model kimliği, etkinlik, `fixedEffort` ve son kota.
2. `pool_select { "kind": "read", "group": "medium" }`: canlı kota kontrolüyle seçim
   ve alternatifler; görev başlatmaz.
3. `pool_submit`:

```json
{
  "prompt": "Kaynak kodu incele ve bulguları özetle.",
  "workspace": "D:\\repositories\\my-project",
  "kind": "read",
  "group": "medium",
  "idempotencyKey": "review-project-001"
}
```

Seçim adımı isteğe bağlıdır; `pool_submit` aynı kota kontrolünü yapar. Başlatılan
kimlikle `pool_get_task { "taskId": "..." }` çağırın. `modelId`, `group`, `effort`
seçilen politikayı; `reportedModel` varsa CLI'ın bildirdiği çalışan sürümü gösterir.
`reportedModel: null` kimliğin bağımsız olarak bildirilmediğini ifade eder.

Yanıt kaybolursa aynı içerik ve aynı idempotencyKey kullanılır. Yeni bir anahtar,
yeni bir iş demektir. Başlamış/başarısız yazma işini başka modelde körlemesine
tekrarlamayın; `needs_review` kullanıcı incelemesi ister.

## Seçim kuralları

- `pool_get_policy {}` içindeki selectionMode `manual` ise `group` zorunludur ve
  yalnızca `high`, `medium`, `low` kabul edilir. Havuz dışındaki açık model de reddedilir.
- `auto` modunda grup verilmezse uygun katalogdan seçilir. Grup verilirse o havuz
  bağlayıcıdır. Havuz üyeliğinde sabit efor varsa onu değiştirmeyin veya alanı boş bırakın.
- Aynı havuzda kota dolmuş bağlantı atlanır. `routeId` veya `modelId` sabitlerseniz
  havuzun diğer üyelerine otomatik geçişi daraltmış olursunuz.
- Ücretli API otomatik kullanımı yalnızca sahibinin açık `autoSelect` tercihiyle olur.
- Sahibin gizlediği model/aileler listelenmez ve açık model isteğiyle de kullanılamaz. Ajan grup düzenlemesi bu filtreleri kaldıramaz. Giriş gerekiyorsa kullanıcı Modeller veya Ayarlar ekranından resmî CLI girişini tamamlar.
- Kota desteklenmiyorsa `unknown`/boş windows dönebilir; bunu sıfır veya sınırsız saymayın.

## Havuz üyeliği yönetimi

Kullanıcı `groupingMode: agent` açmışsa politika revision'ı ile:

```json
{
  "revision": "pool_get_policy yanıtındaki revision",
  "assignments": [
    { "routeId": "codex-local", "modelId": "katalogdaki-tam-kimlik", "group": "high", "effort": "high" }
  ]
}
```

Bunu `pool_assign_groups` aracına verin. Başka havuzlardaki üyelikler korunur.
`remove: true` yalnızca belirtilen üyeliği çıkarır. Kullanıcının eforunu değiştirmek
için açık talimat olmadıkça mevcut eforu koruyun. Bu araç ödeme, yetki veya seçim
modunu değiştiremez. Revizyon çakışırsa güncel politika ve havuzları yeniden okuyun.

## Hatalar

| Kod | Yapılacak işlem |
| --- | --- |
| POOL_REQUIRED | Manuel modda high / medium / low belirtin. |
| NO_ROUTE | Seçilen havuzun üyelerini, efor kuralını, kotasını ve etkinliğini kontrol edin. |
| GROUPING_DENIED | Üyelik değişikliği kullanıcıya ait; ajan yetkisi kapalı. |
| CONFIG_CONFLICT | Yeni revision ve havuz listesini okuyun; değişikliği yeniden değerlendirin. |
| INVALID_REQUEST | Araç şemasındaki alan/tür/sınırları düzeltin. |
| IDEMPOTENCY_CONFLICT | Aynı anahtarı farklı görev içeriğiyle kullanmayın. |
| WORKSPACE_DENIED | İzinli proje klasörü kullanın; yönetim erişimini aşmaya çalışmayın. |

CLI eşdeğeri:

```text
cli-agent-pool select --kind read --group medium
cli-agent-pool run --kind read --group medium --workspace D:\repositories\my-project --prompt "Kaynak kodu incele"
```
# Editor-neutral JSON transport

`cli-agent-pool rpc` accepts one UTF-8 JSON object on stdin and returns JSON on
stdout, including errors (`error.code`, `error.message`, nonzero exit status).
It starts the shared daemon when needed. Prompts and credentials need not appear
in shell arguments. Only the same 11 agent MCP tools are callable; owner management
operations are unavailable through RPC. Input is bounded at 1 MB; tool/HTTP limits
still apply. Example stdin:

```json
{"tool":"pool_select","arguments":{"kind":"write","group":"medium","minRemainingPercent":10}}
```

`minRemainingPercent` on `pool_select` and `pool_submit` can raise the owner's
minimum quota reserve, never lower it. Unknown quota follows the existing bounded
task policy; it does not establish a numeric reserve guarantee. Fixed owner effort
and manual group boundaries apply equally to MCP and JSON callers.

Project Brain 3.3.0+ uses this transport for discovery, selection and durable task
submission. Brain's planning/evidence/runtime remains a separate skill. Its default
task tiers L/M/H map to Pool's low/medium/high groups. A restart resumes the saved
task ID or exact idempotent request; no failed write is replayed automatically.

## Freebuff and other editors

Run `cli-agent-pool mcp-config` to print a credential-free stdio server entry using
the current installed Node and Pool entry paths. Merge its `cli-agent-pool` entry
into the editor's `mcpServers` object without replacing existing server entries.
Freebuff Desktop/CLI supports `~/.agents/mcp.json`; restart/reload its MCP connection
after configuration. The stdio bridge wakes Pool if stopped and exposes the same
11 tools and owner policy. Native Freebuff trust/permission prompts still apply.

This makes Freebuff a Pool client. The installed Freebuff 0.2.29 CLI exposes neither
headless prompt execution nor exact model/effort selection in `--help`; it is not
advertised as an executable Pool model provider. No private upstream proxy or
credential extraction is used. See the official [MCP loader](https://github.com/CodebuffAI/freebuff/blob/main/sdk/src/agents/load-mcp-config.ts)
and [CLI argument contract](https://github.com/CodebuffAI/freebuff/blob/main/cli/src/cli-args.ts).

