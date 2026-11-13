// Options: URL, API-ключ и ЛЮБОЕ количество порогов оповещения (в кредитах).

const $ = (id) => document.getElementById(id);

const DEFAULT_ENDPOINT = 'https://ai.wormsoft.ru/api/v1/account/limits';

// ---------- Динамический список порогов ----------

function addRow(value) {
  const list = $('threshold-list');
  const row = document.createElement('div');
  row.className = 'threshold-row';

  const label = document.createElement('span');
  label.className = 't-label';
  label.textContent = 'Порог ≤';

  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '100';
  input.placeholder = 'напр. 5000';
  if (value !== undefined && value !== null && value !== '') input.value = value;

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'rm';
  rm.title = 'Удалить порог';
  rm.textContent = '✕';
  rm.addEventListener('click', () => {
    row.remove();
    // Кнопка «добавить» видна всегда; при пустом списке оставляем хотя бы одну строку
    if (list.children.length === 0) addRow('');
  });

  row.append(label, input, rm);
  list.append(row);
  return row;
}

function collectThresholds() {
  const rows = $('threshold-list').querySelectorAll('.threshold-row input');
  const values = [];
  for (const input of rows) {
    const n = Number(input.value);
    if (input.value !== '' && Number.isFinite(n) && n >= 0) values.push(n);
  }
  // Уникальные значения, по убыванию
  return [...new Set(values)].sort((a, b) => b - a);
}

function renderRows(values) {
  const list = $('threshold-list');
  list.innerHTML = '';
  if (values.length === 0) {
    addRow('');
    return;
  }
  for (const v of values) addRow(v);
}

// ---------- Инициализация ----------

document.addEventListener('DOMContentLoaded', async () => {
  const { endpoint, apiKey, thresholds, thresholdCredits, notifyOnDrop, notifyOnUpdate } =
    await chrome.storage.local.get(['endpoint', 'apiKey', 'thresholds', 'thresholdCredits', 'notifyOnDrop', 'notifyOnUpdate']);

  $('endpoint').value = endpoint || DEFAULT_ENDPOINT;
  $('apikey').value = apiKey || '';
  $('notify').checked = notifyOnDrop ?? true;
  $('notify-update').checked = notifyOnUpdate ?? true;

  // Миграция с одиночного порога
  let list = Array.isArray(thresholds) ? thresholds : [];
  if (list.length === 0 && Number.isFinite(thresholdCredits)) list = [thresholdCredits];
  renderRows(list);

  $('add-threshold').addEventListener('click', () => addRow(''));
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

async function save(silent = false) {
  await chrome.storage.local.set({
    endpoint: $('endpoint').value.trim() || DEFAULT_ENDPOINT,
    apiKey: $('apikey').value.trim(),
    thresholds: collectThresholds(),
    notifyOnDrop: $('notify').checked,
    notifyOnUpdate: $('notify-update').checked,
  });
  if (!silent) {
    const t = collectThresholds();
    setStatus('ok', t.length
      ? `Сохранено. Порогов: ${t.length} (${t.map((x) => Math.round(x).toLocaleString('ru-RU')).join('; ')}).`
      : 'Сохранено. Порогов нет — уведомления не будут приходить.');
  }
}

function fmt(n) {
  return n === null || n === undefined ? '—' : Math.round(n).toLocaleString('ru-RU');
}

function setStatus(kind, text) {
  const el = $('status');
  el.className = kind;
  el.textContent = text;
}
