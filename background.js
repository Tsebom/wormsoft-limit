// WormSoft Limit Monitor — фоновой сервис-воркер (MV3)
// Опрос https://ai.wormsoft.ru/api/v1/account/limits раз в 5 минут,
// обновление значка, уведомления о низком остатке.

const ALARM_NAME = 'wormsoft-limit-check';
const CHECK_INTERVAL_MIN = 5;

const DEFAULTS = {
  endpoint: 'https://ai.wormsoft.ru/api/v1/account/limits',
  apiKey: '',
  thresholdCredits: 5000,
  notifyOnDrop: true,
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

async function updateBadge(state) {
  const action = chrome.action;
  if (state.error) {
    await action.setBadgeText({ text: '!' });
    await action.setBadgeBackgroundColor({ color: '#c62828' });
    return;
  }
  if (state.total === null) return;
  await action.setBadgeText({ text: fmtNum(state.total) });
  // Красный — кредитов нет; оранжевый — заморозка (действуют лимиты Free); зелёный — норма.
  const color = state.total <= 0 ? '#c62828' : state.isFrozen ? '#ef6c00' : '#2e7d32';
  await action.setBadgeBackgroundColor({ color });
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

// ---------- Уведомления ----------

async function maybeNotify(state, prev) {
  const settings = await getSettings();
  if (!settings.notifyOnDrop || !state.ok || state.total === null) return;

  const threshold = settings.thresholdCredits;
  const isBelow = state.total <= threshold;
  const wasAbove = prev && prev.ok && prev.total !== null ? prev.total > threshold : null;
  if (!isBelow || wasAbove === false) return;

  chrome.notifications.create('wormsoft-limit-low', {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'WormSoft: кредиты на исходе',
    message: `Осталось ${fmtNum(state.total)} кредитов (порог: ${fmtNum(threshold)}).`,
  });
}

// ---------- Оркестрация ----------

async function runCheck() {
  const prev = (await chrome.storage.local.get('lastState')).lastState || null;
  const state = await checkLimit();
  await chrome.storage.local.set({ lastState: state });
  await updateBadge(state);
  await maybeNotify(state, prev);
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
