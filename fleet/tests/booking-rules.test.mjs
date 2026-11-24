import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {contactUrl, message, quote, todayInMoscow} from '../assets/booking-rules.js';

const {vehicles} = JSON.parse(readFileSync(new URL('../../fleet.json', import.meta.url)));
const from = '2026-12-10';
const today = '2026-11-24';

test('все тарифы из fleet.json рассчитываются только для указанного числа суток', () => {
  for (const vehicle of vehicles) {
    for (const tariff of vehicle.tariffs) {
      const end = new Date(Date.parse(from) + tariff.days * 86400000).toISOString().slice(0, 10);
      assert.deepEqual(quote(from, end, vehicle, today), {
        state: 'priced', days: tariff.days, total: tariff.daily_rub * tariff.days
      });
    }
    const state = vehicle.minimum_days > 2 ? 'minimum' : 'unknown';
    assert.deepEqual(quote(from, '2026-12-12', vehicle, today), {state, days: 2});
    if (state === 'minimum') {
      assert.doesNotMatch(message(vehicle, from, '2026-12-12', {state, days: 2}), /10\.12\.2026/);
    }
  }
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
