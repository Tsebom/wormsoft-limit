// Общий для фонового воркера (importScripts) и popup (обычный <script>)
// код: плавный градиент «зелёный 100% → красный 0%» (доля остатка от ориентира по тарифу).
// Используется и для цвета бейджа, и для цвета счётчика/индикатора в popup.

// hue 120→0 при фиксированных насыщенности/яркости
// (ближе к исходным #2e7d32 и #c62828).
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
