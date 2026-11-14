// WormSoft Limit Monitor — фоновой сервис-воркер (MV3)
// Опрос https://ai.wormsoft.ru/api/v1/account/limits раз в 5 минут и
// обновление значка (остаток кредитов прямо на иконке).

const ALARM_NAME = 'wormsoft-limit-check';
const CHECK_INTERVAL_MIN = 5;

const DEFAULTS = {
  endpoint: 'https://ai.wormsoft.ru/api/v1/account/limits',
  apiKey: '',
};

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

// Плавный градиент «зелёный 100% → красный 0%»: hue 120→0 при фиксированных
// насыщенности/яркости (ближе к исходным #2e7d32 и #c62828).
function badgeColorFor(pct) {
  const p = Math.max(0, Math.min(1, pct));
  const h = 120 * p, s = 0.7, l = 0.4;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

async function updateBadge(state, memory) {
  const action = chrome.action;
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

async function updateQuotaMemory(state) {
  if (!state.ok || state.subscription === null) return;
  const { quotaMemory } = await chrome.storage.local.get('quotaMemory');
  const cur = quotaMemory && typeof quotaMemory === 'object' ? quotaMemory : null;

  if (!cur || cur.type !== state.subscriptionType) {
    // Смена подписки — сбрасываем максимум и запоминаем с нуля.
    await chrome.storage.local.set({
      quotaMemory: { type: state.subscriptionType, maxSubscription: state.subscription },
    });
    return;
  }
  if (state.subscription > cur.maxSubscription) {
    // Новый максимум (например, только что произошёл сброс периода).
    await chrome.storage.local.set({
      quotaMemory: { ...cur, maxSubscription: state.subscription },
    });
  }
}

// ---------- Оркестрация ----------

async function runCheck() {
  const state = await checkLimit();
  await updateQuotaMemory(state);
  const { quotaMemory } = await chrome.storage.local.get('quotaMemory');
  await chrome.storage.local.set({ lastState: state });
  await updateBadge(state, quotaMemory);
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

// Повторная проверка по запросу popup / options
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'CHECK_NOW') {
    runCheck().then(() =>
      chrome.storage.local.get('lastState', (r) => sendResponse({ ok: true, state: r.lastState }))
    );
    return true; // асинхронный ответ
  }
});
