import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {contactUrl, message, quote, todayInMoscow} from '../assets/booking-rules.js';

const {vehicles} = JSON.parse(readFileSync(new URL('../../fleet.json', import.meta.url)));
const from = '2026-12-10';
const today = '2026-11-24';

test('все 18 порогов, соседние сроки и аренда дольше 30 суток', () => {
  for (const vehicle of vehicles) {
    const ordered = [...vehicle.tariffs].sort((a, b) => a.days - b.days);
    const lengths = new Set([31, 45, ...ordered.flatMap(rate => [rate.days - 1, rate.days, rate.days + 1])]);
    for (const days of lengths) {
      const end = new Date(Date.parse(from) + days * 86400000).toISOString().slice(0, 10);
      const outcome = quote(from, end, vehicle, today);
      if (!days) {
        assert.equal(outcome.state, 'order');
      } else if (days < vehicle.minimum_days) {
        assert.deepEqual(outcome, {state: 'minimum', days});
        assert.doesNotMatch(message(vehicle, from, end, outcome), /10\.12\.2026/);
      } else {
        const daily = ordered.filter(rate => rate.days <= days).at(-1).daily_rub;
        const rental = daily * days, deposit = vehicle.deposit.rub;
        assert.deepEqual(outcome, {state: 'priced', days, daily, rental, deposit, total: rental + deposit});
      }
    }
  }
});

test('контрольный расчёт Logan на 5 суток и стоимость в сообщении', () => {
  const logan = vehicles.find(v => v.id === 'renault-logan');
  const end = '2026-12-15';
  const result = quote(from, end, logan, today);
  assert.deepEqual(result, {state:'priced', days:5, daily:2200, rental:11000, deposit:7000, total:18000});
  assert.match(message(logan, from, end, result), /11\s000 ₽ без возвратного депозита/);
});

test('проверка отсутствующих, недействительных и прошедших дат', () => {
  const [car] = vehicles;
  for (const [a,b,state] of [
    ['', '', 'empty'], [from, '', 'incomplete'], [from, from, 'order'],
    [from, '2026-12-09', 'order'], ['2026-02-30', from, 'invalid'], ['2026-11-23', from, 'past']
  ]) assert.equal(quote(a,b,car,today).state, state);
  assert.equal(todayInMoscow(new Date('2026-11-24T22:00:00Z')), '2026-11-25');
});

test('сообщения для конкретной машины, без дат и для общей связи', () => {
  const [car] = vehicles;
  const end = '2026-12-17';
  const dates = message(car, from, end, quote(from, end, car, today));
  assert.match(dates, /Peugeot 308 SW 2008 года с 10\.12\.2026 по 17\.12\.2026, на 7 суток/);
  assert.match(message(car), /Peugeot 308 SW 2008 года\. Подскажите/);
  assert.match(message(null), /какие машины сейчас доступны/);
  const special = message({...car, name: 'Модель & «Ё» + #'});
  for (const base of ['https://t.me/example','https://wa.me/12345678']) {
    const target = new URL(contactUrl(base, dates));
    assert.equal(target.searchParams.get('text'), dates);
    assert.equal(target.origin + target.pathname, base);
    assert.equal(new URL(contactUrl(base, special)).searchParams.get('text'), special);
  }
});
