// WormSoft Limit Monitor — фоновой сервис-воркер (MV3)
// Опрос https://ai.wormsoft.ru/api/v1/account/limits раз в минуту и
// обновление значка (остаток кредитов прямо на иконке).
importScripts('shared.js'); // badgeColorFor() — общий с popup

const ALARM_NAME = 'wormsoft-limit-check';
const CHECK_INTERVAL_MIN = 1;

const DEFAULTS = {
  endpoint: 'https://ai.wormsoft.ru/api/v1/account/limits',
  apiKey: '',
  // Пробный запрос (запуск счётчика сброса) выключен по умолчанию:
  // он реально списывает кредиты, поэтому включается явно в настройках.
  probeEnabled: false,
  probeModel: 'openai/gpt-5.4-mini',
};

// ---------- Пробный запрос (константы) ----------

// LLM endpoint: минимальный запрос после обновления лимита запускает счётчик
// до следующего обновления. Хост тот же, что и у endpoint лимитов, поэтому
// отдельных host_permissions не требуется.
const PROBE_URL = 'https://ai.wormsoft.ru/api/gpt/chat/completions';
const PROBE_MAX_TOKENS = 1;                    // минимальный ответ — минимальная цена
const PROBE_COOLDOWN_MS = 10 * 60 * 1000;      // пауза между попытками
const PROBE_MAX_ATTEMPTS = 3;                  // неудачных попыток на одно обновление

// ---------- Настройки ----------

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// ---------- Формат ответа WormSoft ----------

// {
//   "userId": 123,
//   "subscriptionType": "payed",
//   "subscriptionLimit": 1234567,          <- остаток по тарифу
//   "subscriptionLimitResetAt": 1730000000,<- unix sec сброса тарифа
//   "boostLimit": 1000000,                 <- остаток буста (списывается раньше)
//   "boostLimitResetAt": 1730003600,
//   "totalLimit": 2234567,                 <- subscriptionLimit + boostLimit
//   "isFrozen": false
// }
function extractQuota(data) {
  if (!data || typeof data !== 'object') return null;
  const o = data.data && typeof data.data === 'object' ? data.data : data;

  if (
    o.subscriptionLimit !== undefined ||
    o.totalLimit !== undefined ||
    o.boostLimit !== undefined
  ) {
    const sub = num(o.subscriptionLimit);
    const boost = num(o.boostLimit);
    const total = num(o.totalLimit) ?? (sub !== null || boost !== null ? (sub ?? 0) + (boost ?? 0) : null);
    if (total === null) return null;
    return {
      subscription: sub,
      boost: boost,
      total,
      subscriptionResetAt: num(o.subscriptionLimitResetAt) ?? 0,
      boostResetAt: num(o.boostLimitResetAt) ?? 0,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
      isFrozen: o.isFrozen === true,
    };
  }

  // Fallback на случай изменений API: ищем привычные пары полей.
  for (const obj of [o, o.quota, o.limit, o.usage, o.account]) {
    if (!obj || typeof obj !== 'object') continue;
    const remaining = num(obj.remaining ?? obj.remaining_tokens ?? obj.balance ?? obj.left);
    if (remaining !== null) {
      return { subscription: null, boost: null, total: remaining, subscriptionResetAt: 0, boostResetAt: 0, subscriptionType: null, isFrozen: false };
    }
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- Валидация эндпоинта (безопасность) ----------
// API-ключ уходит в Authorization-заголовке ровно на этот URL, поэтому
// защищаемся от http://, опечаток и спуф-хостов (ai.wormsoft.ru.evil.ru):
// допустим только https и хосты *.wormsoft.ru. Иначе запрос не выполняется
// и ключ никуда не отправляется.

function validateEndpoint(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'Некорректный URL эндпоинта.';
  }
  if (u.protocol !== 'https:') {
    return 'Эндпоинт должен быть https — ключ не должен уходить в открытом виде.';
  }
  const host = u.hostname;
  if (host !== 'ai.wormsoft.ru' && !host.endsWith('.wormsoft.ru')) {
    return `Хост «${host}» не относится к wormsoft.ru — запрос отменён, чтобы API-ключ не был отправлен не туда.`;
  }
  return null;
}

// ---------- Запрос лимита ----------

async function checkLimit() {
  const settings = await getSettings();
  const state = {
    lastCheck: Date.now(),
    ok: false,
    error: null,
    subscription: null,
    boost: null,
    total: null,
    subscriptionResetAt: 0,
    boostResetAt: 0,
    subscriptionType: null,
    isFrozen: false,
  };

  if (!settings.endpoint) {
    state.error = 'Не указан URL API. Откройте настройки расширения.';
    return state;
  }
  const endpointError = validateEndpoint(settings.endpoint);
  if (endpointError) {
    state.error = endpointError;
    return state;
  }
  if (!settings.apiKey) {
    state.error = 'Не указан API-ключ. Откройте настройки расширения.';
    return state;
  }

  try {
    const res = await fetch(settings.endpoint, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Accept': 'application/json',
      },
      cache: 'no-store',
    });

    if (res.status === 401) {
      state.error = '401 Unauthorized — неверный или отозванный API-ключ.';
      return state;
    }
    if (res.status === 429) {
      state.error = '429 Too Many Requests — превышен rate limit ключа.';
      return state;
    }
    if (res.status === 404) {
      state.error = '404 Not Found — ключ валиден, но запись пользователя удалена.';
      return state;
    }
    if (!res.ok) {
      state.error = `HTTP ${res.status} ${res.statusText}`.trim();
      return state;
    }

    const data = await res.json();
    const quota = extractQuota(data);
    if (!quota) {
      state.error = 'Не удалось распознать лимиты в ответе API.';
      return state;
    }

    Object.assign(state, quota);
    state.ok = true;
  } catch (e) {
    state.error = `Ошибка запроса: ${e.message}`;
  }

  return state;
}

// ---------- Значок ----------

async function updateBadge(state, memory) {
  const action = chrome.action;
  // Текст бейджа — всегда белый (иначе Chrome сам подбирает цвет под фон
  // и цифры на жёлто-зелёных тонах градиента могут стать тёмными).
  if (typeof action.setBadgeTextColor === 'function') {
    await action.setBadgeTextColor({ color: '#ffffff' });
  }
  if (state.error) {
    await action.setBadgeText({ text: '!' });
    await action.setBadgeBackgroundColor({ color: '#c62828' });
    return;
  }
  if (state.total === null) return;
  await action.setBadgeText({ text: fmtNum(state.total) });
  if (state.isFrozen) {
    // Оранжевый — заморозка (действуют лимиты Free).
    await action.setBadgeBackgroundColor({ color: '#ef6c00' });
    return;
  }
  // Градиент от ориентира по тарифу: сколько % кредита осталось.
  // Если ориентир ещё не зафиксирован (первые проверки до сброса периода) — зелёный.
  const hasOrientation =
    state.subscription !== null &&
    memory &&
    memory.type === state.subscriptionType &&
    typeof memory.maxSubscription === 'number' &&
    memory.maxSubscription > 0;
  const pct = hasOrientation ? state.subscription / memory.maxSubscription : 1;
  await action.setBadgeBackgroundColor({ color: badgeColorFor(pct) });
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

// ---------- Память «максимального зафиксированного» остатка по тарифу ----------
// API не возвращает размер полного лимита подписки, поэтому в качестве
// ориентира (приближения) берём самое большое наблюдаемое значение
// subscriptionLimit с момента последнего изменения тарифа. При смене
// subscriptionType (включая заморозку) память сбрасывается и ориентир
// определяется заново.
//
// Поля пробного запроса (см. следующий блок):
//   probedMax     — maxSubscription, для которого пробный запрос уже выполнен
//                   (или выработан лимит попыток); закрывает цикл, чтобы не
//                   списывать кредиты повторно в пределах одного обновления;
//   lastProbeAt   — время последней попытки (cooldown между попытками);
//   probeAttempts — число неудачных попыток для текущего цикла.

async function readQuotaMemory() {
  const { quotaMemory } = await chrome.storage.local.get('quotaMemory');
  return quotaMemory && typeof quotaMemory === 'object' ? quotaMemory : null;
}

// Возвращает true, если это наблюдение — обновление лимита:
// остаток тарифа стал больше прежнего зафиксированного максимума.
async function updateQuotaMemory(state) {
  if (!state.ok || state.subscription === null) return false;
  const cur = await readQuotaMemory();

  let refreshed = false;
  let next;
  if (!cur || cur.type !== state.subscriptionType) {
    // Смена подписки — сбрасываем максимум и запоминаем с нуля.
    // Пробный запрос здесь НЕ делаем: неизвестно, в какой точке цикла
    // находится новый тариф, списание может уйти вхолостую. Ждём первого
    // реального обновления лимита (подскока остатка) — только оно является
    // безопасным моментом для запуска счётчика.
    next = {
      type: state.subscriptionType,
      maxSubscription: state.subscription,
      probedMax: null,
      lastProbeAt: 0,
      probeAttempts: 0,
    };
  } else {
    next = {
      ...cur,
      // Новый максимум (например, только что произошло обновление лимита).
      maxSubscription: Math.max(cur.maxSubscription ?? 0, state.subscription),
    };
    refreshed = state.subscription > (cur.maxSubscription ?? 0);
    if (refreshed) {
      // Обновление лимита — новый цикл: пробный запрос снова разрешён.
      next.probedMax = null;
      next.probeAttempts = 0;
    }
  }
  await chrome.storage.local.set({ quotaMemory: next });
  return refreshed;
}

// ---------- Пробный запрос: запуск счётчика до следующего обновления ----------
// Обновление лимита привязано к первому запросу после предыдущего обновления:
// счётчик до следующего обновления стартует только с него. Если после
// обновления лимита запросов долго не делать, следующее обновление (и полный
// остаток тарифа) откладывается. Чтобы счётчик стартовал ровно в момент
// обновления, расширение может сразу отправить минимальный LLM-запрос
// (max_tokens: 1 — стоимость в единицы кредитов, заведомо <= 100).
//
// Логика «не сжечь кредиты вхолостую»:
//   • выключено по умолчанию, включается явно в настройках;
//   • только в момент обновления лимита (остаток тарифа подпрыгнул до нового
//     максимума) — в остальные моменты запрос ничего не даёт;
//   • при активном бусте НЕ делается: списание ушло бы в буст-кредиты, а
//     пользователь с бустом и так делает запросы — бусты не учитываются;
//   • не делается при ошибках API и заморозке подписки;
//   • один цикл = максимум одна успешная попытка (probedMax), между
//     попытками cooldown, после 3 неудач цикл закрывается без успеха.
//   • при смене тарифа пробный запрос не делается до первого обновления.

async function maybeProbe(state, refreshed, settings) {
  const info = { fired: false, ok: null, error: null, at: 0 };
  if (!refreshed) return info;
  if (!settings.probeEnabled) return info;
  if (!state.ok || state.isFrozen) return info;
  if (state.subscription === null || state.subscription <= 0) return info;
  // Бусты не учитываются (см. выше).
  if (state.boost !== null && state.boost > 0) return info;

  const mem = await readQuotaMemory();
  if (!mem || mem.type !== state.subscriptionType) return info;
  // Цикл уже закрыт (успех или выработан лимит попыток) — не тратим повторно.
  if (mem.probedMax !== null && mem.probedMax === mem.maxSubscription) return info;
  // Cooldown между попытками.
  if (Date.now() - (mem.lastProbeAt || 0) < PROBE_COOLDOWN_MS) return info;

  info.at = Date.now();
  info.fired = true;
  const res = await fireProbe(settings);
  info.ok = res.ok;
  info.error = res.error;

  const cur = await readQuotaMemory();
  if (cur && cur.type === state.subscriptionType) {
    const attempts = res.ok ? 0 : (cur.probeAttempts || 0) + 1;
    const giveUp = !res.ok && attempts >= PROBE_MAX_ATTEMPTS;
    await chrome.storage.local.set({
      quotaMemory: {
        ...cur,
        lastProbeAt: info.at,
        probeAttempts: giveUp ? 0 : attempts,
        // Успех (или 3 неудачи подряд) закрывает цикл.
        probedMax: res.ok || giveUp ? mem.maxSubscription : cur.probedMax ?? null,
      },
    });
  }
  return info;
}

async function fireProbe(settings) {
  // Тот же контроль хоста, что и для endpoint лимитов: ключ не должен
  // уйти на посторонний сервер.
  const endpointError = validateEndpoint(PROBE_URL);
  if (endpointError) return { ok: false, error: endpointError };
  if (!settings.apiKey) return { ok: false, error: 'Не указан API-ключ.' };
  try {
    const res = await fetch(PROBE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        model: settings.probeModel || DEFAULTS.probeModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    }
    // Тело ответа не важно — важен сам запрос-списание, запускающий счётчик.
    await res.json().catch(() => null);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: `Ошибка запроса: ${e.message}` };
  }
}

// ---------- Оркестрация ----------

async function runCheck() {
  const settings = await getSettings();
  const state = await checkLimit();

  // Фиксируем максимум; заодно узнаём, произошло ли обновление лимита
  // (остаток тарифа стал больше прежнего зафиксированного максимума).
  const refreshed = await updateQuotaMemory(state);

  // Пробный запрос — только в момент обновления лимита (см. maybeProbe).
  const probe = await maybeProbe(state, refreshed, settings);

  let finalState = state;
  if (probe.fired) {
    // Перечитываем остаток после списания пробного запроса, чтобы бейдж
    // и popup показывали цифры уже с его учётом.
    finalState = await checkLimit();
    await updateQuotaMemory(finalState);
  }

  const { quotaMemory } = await chrome.storage.local.get('quotaMemory');
  const toStore = { lastState: finalState };
  if (probe.fired) toStore.probeState = probe; // храним последний результат
  await chrome.storage.local.set(toStore);
  await updateBadge(finalState, quotaMemory);
}

async function ensureAlarm() {
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: CHECK_INTERVAL_MIN,
    delayInMinutes: 0.1, // первый запрос почти сразу
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  await runCheck();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runCheck();
});

// Повторная проверка по запросу popup / options.
// Превентивно принимаем сообщения только от контекстов собственного
// расширения (sender.id) — на случай, если когда-нибудь добавятся
// content scripts.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'CHECK_NOW' && sender.id === chrome.runtime.id) {
    runCheck().then(() =>
      chrome.storage.local.get('lastState', (r) => sendResponse({ ok: true, state: r.lastState }))
    );
    return true; // асинхронный ответ
  }
});
