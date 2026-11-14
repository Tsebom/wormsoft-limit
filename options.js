// Options: URL эндпоинта и API-ключ.

const $ = (id) => document.getElementById(id);

const DEFAULT_ENDPOINT = 'https://ai.wormsoft.ru/api/v1/account/limits';

document.addEventListener('DOMContentLoaded', async () => {
  const { endpoint, apiKey, planSize } = await chrome.storage.local.get(['endpoint', 'apiKey', 'planSize']);

  $('endpoint').value = endpoint || DEFAULT_ENDPOINT;
  $('apikey').value = apiKey || '';
  $('plansize').value = planSize > 0 ? planSize : '';

  $('save').addEventListener('click', () => save(false));
  $('test').addEventListener('click', async () => {
    await save(true);
    setStatus('', 'Проверяю…');
    chrome.runtime.sendMessage({ type: 'CHECK_NOW' }, (resp) => {
      const s = resp && resp.state;
      if (s && s.ok) {
        const parts = [];
        if (s.subscription !== null) parts.push(`тариф ${fmt(s.subscription)}`);
        if (s.boost) parts.push(`буст ${fmt(s.boost)}`);
        setStatus('ok', `OK. Всего ${fmt(s.total)} кредитов (${parts.join(', ') || 'нет данных'}).`);
      } else {
        setStatus('err', (s && s.error) || 'Неизвестная ошибка.');
      }
    });
  });
});

function readPlanSize() {
  const n = Math.floor(Number($('plansize').value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function save(silent = false) {
  await chrome.storage.local.set({
    endpoint: $('endpoint').value.trim() || DEFAULT_ENDPOINT,
    apiKey: $('apikey').value.trim(),
    planSize: readPlanSize(),
  });
  if (!silent) setStatus('ok', 'Сохранено.');
}

function fmt(n) {
  return n === null || n === undefined ? '—' : Math.round(n).toLocaleString('ru-RU');
}

function setStatus(kind, text) {
  const el = $('status');
  el.className = kind;
  el.textContent = text;
}
