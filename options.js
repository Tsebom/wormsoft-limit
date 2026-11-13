// Options: ввод URL эндпоинта, API-ключа и порога оповещения (в кредитах).

const $ = (id) => document.getElementById(id);

const DEFAULT_ENDPOINT = 'https://ai.wormsoft.ru/api/v1/account/limits';

document.addEventListener('DOMContentLoaded', async () => {
  const { endpoint, apiKey, thresholdCredits, notifyOnDrop } =
    await chrome.storage.local.get(['endpoint', 'apiKey', 'thresholdCredits', 'notifyOnDrop']);

  $('endpoint').value = endpoint || DEFAULT_ENDPOINT;
  $('apikey').value = apiKey || '';
  $('threshold').value = thresholdCredits ?? 5000;
  $('notify').checked = notifyOnDrop ?? true;

  $('save').addEventListener('click', save);
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

async function save(silent = false) {
  await chrome.storage.local.set({
    endpoint: $('endpoint').value.trim() || DEFAULT_ENDPOINT,
    apiKey: $('apikey').value.trim(),
    thresholdCredits: clampNum($('threshold').value, 0, Number.MAX_SAFE_INTEGER, 5000),
    notifyOnDrop: $('notify').checked,
  });
  if (!silent) setStatus('ok', 'Сохранено. Проверка запускается каждые 5 минут.');
}

function fmt(n) {
  return n === null || n === undefined ? '—' : Math.round(n).toLocaleString('ru-RU');
}

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function setStatus(kind, text) {
  const el = $('status');
  el.className = kind;
  el.textContent = text;
}
