// Popup: показываем состояние из chrome.storage и предлагаем повторную проверку.

const $ = (id) => document.getElementById(id);

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  if (Number.isFinite(n)) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  return '—';
}

function fmtFull(n) {
  return n === null || n === undefined ? '—' : Math.round(n).toLocaleString('ru-RU');
}

// Unix-секунды -> "через 3 ч 20 мин"; title = точная дата
function fmtReset(unixSec) {
  if (!unixSec) return { text: '—', title: '' };
  const target = unixSec * 1000;
  const diff = target - Date.now();
  if (diff <= 0) return { text: 'скоро', title: new Date(target).toLocaleString('ru-RU') };
  const mins = Math.floor(diff / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  let text;
  if (h >= 24) text = `через ${Math.floor(h / 24)} д ${h % 24} ч`;
  else if (h > 0) text = `через ${h} ч ${m} мин`;
  else text = `через ${m} мин`;
  return { text, title: new Date(target).toLocaleString('ru-RU') };
}

function setReset(id, unixSec, emptyText) {
  const el = $(id);
  if (!unixSec) {
    el.textContent = emptyText || '—';
    el.title = '';
    return;
  }
  const { text, title } = fmtReset(unixSec);
  el.textContent = text;
  el.title = title;
}

function render(state, memory) {
  const dot = $('status-dot');
  const quotaView = $('quota-view');
  const errorView = $('error-view');

  if (!state) {
    quotaView.style.display = 'none';
    errorView.style.display = 'block';
    errorView.textContent = 'Ещё не было ни одной проверки. Нажмите «Проверить сейчас».';
    return;
  }

  if (state.error) {
    quotaView.style.display = 'none';
    errorView.style.display = 'block';
    errorView.innerHTML = `${state.error} <a href="#" id="go-options">Открыть настройки →</a>`;
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#c62828;display:inline-block';
    $('go-options').addEventListener('click', (e) => {
      e.preventDefault();
      openOptions();
    });
    return;
  }

  errorView.style.display = 'none';
  quotaView.style.display = 'block';

  const big = $('big');
  const total = state.total;
  big.textContent = fmtNum(total);
  big.className = 'big ' + (total <= 0 ? 'danger' : state.isFrozen ? 'warn' : 'ok');

  const color = total <= 0 ? '#c62828' : state.isFrozen ? '#ef6c00' : '#2e7d32';
  dot.style.cssText = `width:10px;height:10px;border-radius:50%;background:${color};display:inline-block`;

  $('frozen-banner').style.display = state.isFrozen ? 'block' : 'none';

  // Буст списывается раньше тарифа — показываем его первым с пометкой.
  $('subscription').textContent = fmtFull(state.subscription);
  $('boost').textContent = state.boost
    ? `${fmtFull(state.boost)} (тратится первым)`
    : 'нет активного буста';

  setReset('sub-reset', state.subscriptionResetAt,
    state.subscription === 0 ? 'по запросу при следующем списании' : '—');
  setReset('boost-reset', state.boostResetAt, state.boost ? '—' : 'нет активного буста');

  $('sub-type').textContent = state.subscriptionType
    ? state.subscriptionType + (state.isFrozen ? ' (заморожена)' : '')
    : '—';

  // Ориентир — максимальный зафиксированный остаток по тарифу (API размер
  // лимита не возвращает). Сбрасывается при смене subscriptionType.
  const usage = $('usage');
  if (
    state.subscription !== null &&
    memory &&
    memory.type === state.subscriptionType &&
    typeof memory.maxSubscription === 'number' &&
    memory.maxSubscription > 0
  ) {
    const max = memory.maxSubscription;
    const pct = Math.max(0, Math.min(100, Math.round((1 - state.subscription / max) * 100)));
    usage.textContent = `${pct}% из ≈ ${fmtFull(max)}`;
    usage.title = 'Ориентир — максимальный зафиксированный остаток по тарифу с момента последней смены тарифа (API не возвращает размер лимита)';
  } else {
    usage.textContent = '—';
    usage.title = '';
  }

}

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}

document.addEventListener('DOMContentLoaded', async () => {
  const { lastState, quotaMemory } = await chrome.storage.local.get(['lastState', 'quotaMemory']);
  render(lastState || null, quotaMemory || null);
  $('refresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CHECK_NOW' }, async (resp) => {
      const { quotaMemory: mem } = await chrome.storage.local.get('quotaMemory');
      render(resp && resp.state ? resp.state : null, mem || null);
    });
  });
  $('open-options').addEventListener('click', openOptions);
});
