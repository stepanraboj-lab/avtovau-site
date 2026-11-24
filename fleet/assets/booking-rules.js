const day = 86_400_000;
const dateLabel = new Intl.DateTimeFormat('ru-RU', {timeZone: 'UTC'});
const durationLabel = new Intl.PluralRules('ru-RU');
const money = new Intl.NumberFormat('ru-RU');

function dateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
}

export function todayInMoscow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(({type, value}) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function quote(start, end, vehicle, today = todayInMoscow()) {
  if (!start && !end) return {state: 'empty'};
  if (!start || !end) return {state: 'incomplete'};
  const from = dateValue(start), to = dateValue(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return {state: 'invalid'};
  if (start < today) return {state: 'past'};
  if (to <= from) return {state: 'order'};
  const days = (to - from) / day;
  if (days < vehicle.minimum_days) return {state: 'minimum', days};
  const rate = vehicle.tariffs.reduce((best, item) => (
    item.days <= days && (!best || item.days > best.days) ? item : best
  ), null);
  if (!rate) return {state: 'unknown', days};
  const rental = days * rate.daily_rub;
  const deposit = vehicle.deposit.rub;
  return {state: 'priced', days, daily: rate.daily_rub, rental, deposit, total: rental + deposit};
}

export function rubles(amount) {
  return `${money.format(amount)} ₽`;
}

export function rentalDays(days) {
  const unit = {one: 'сутки', few: 'суток', many: 'суток'};
  return `${days} ${unit[durationLabel.select(days)] ?? 'суток'}`;
}

export function message(vehicle, start = '', end = '', result = {}) {
  if (!vehicle) return 'Здравствуйте! Интересует аренда автомобиля. Подскажите, пожалуйста, какие машины сейчас доступны?';
  const validPeriod = result.state === 'priced' || result.state === 'unknown';
  const dates = validPeriod ? ` с ${dateLabel.format(dateValue(start))} по ${dateLabel.format(dateValue(end))}, на ${rentalDays(result.days)}` : '';
  const estimate = result.state === 'priced' ? ` Предварительная стоимость аренды — ${rubles(result.rental)} без возвратного депозита.` : '';
  return `Здравствуйте! Хочу арендовать ${vehicle.name} ${vehicle.year} года${dates}.${estimate} Подскажите, пожалуйста, доступен ли автомобиль?`;
}

export function contactUrl(base, body) {
  const url = new URL(base);
  url.searchParams.set('text', body);
  return url.href;
}
