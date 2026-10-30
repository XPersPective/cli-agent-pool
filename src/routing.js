import { activeBillings } from './config.js';
import { quotaApplies } from '../web/pool-state.js';
import { supportsExecution } from './task-protocol.js';

export function rejectionReason(model, route, snapshot, request) {
  if (!model.enabled) return 'DISABLED';
  if (!activeBillings.has(model.billing)) return 'BILLING_UNCONFIRMED';
  if (!request.routeId && !model.autoSelect) return 'AUTOSELECT_DISABLED';
  if (!model.kinds.includes(request.kind)) return 'KIND_UNSUPPORTED';
  if (request.mode === 'execute' && !supportsExecution(route)) return 'EXECUTION_UNSUPPORTED';
  if (request.effort && model.fixedEffort && request.effort !== model.fixedEffort) return 'FIXED_EFFORT';
  if (request.effort && !model.efforts.includes(request.effort)) return 'EFFORT_UNSUPPORTED';
  if (snapshot && Date.now() - Date.parse(snapshot.observedAt) < 60_000) {
    if (snapshot.status === 'auth_required') return 'AUTH_REQUIRED';
    if (snapshot.subscription === 'none' && ['subscription', 'token_plan'].includes(route.billing)) return 'SUBSCRIPTION_REQUIRED';
    if (snapshot.status === 'rate_limited' || snapshot.windows?.some(window => quotaApplies(window, model.id) && window.remainingPercent != null && window.remainingPercent <= Math.max(route.minRemainingPercent, request.minRemainingPercent ?? 0))) return 'QUOTA_RESERVE';
  }
  return null;
}

const explanations = {
  DISABLED: 'bağlantı veya model kapalı', BILLING_UNCONFIRMED: 'ödeme/plan türü doğrulanmamış',
  AUTOSELECT_DISABLED: 'otomatik seçime kapalı', KIND_UNSUPPORTED: 'istenen metin/okuma/yazma yeteneği yok',
  EXECUTION_UNSUPPORTED: 'adaptör icra modunu desteklemiyor', FIXED_EFFORT: 'istenen efor havuzun sabit eforuyla çakışıyor',
  EFFORT_UNSUPPORTED: 'istenen efor desteklenmiyor', AUTH_REQUIRED: 'CLI oturumu gerekli',
  SUBSCRIPTION_REQUIRED: 'bu CLI için gerekli plan yok', QUOTA_RESERVE: 'kota dolu veya kalan kota rezervin altında',
};

export function noRouteMessage(request, rejected) {
  const scope = request.group ? `${request.group} havuzunda` : 'seçilen katalogda';
  if (!rejected.size) return `Uygun model yok: ${scope} istenen bağlantı/model üyeliği bulunamadı; model gizlenmiş veya havuza eklenmemiş olabilir. Havuz üyeliğini ve model kimliğini kontrol edin.`;
  return `Uygun model yok (${scope}, ${request.mode || request.kind}): ` + [...rejected].map(([reason, count]) => `${explanations[reason]} (${count})`).join('; ') + '. Kullanıcı kuralları değiştirilmedi.';
}
