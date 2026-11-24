import {contactUrl, message, quote, rentalDays, todayInMoscow} from './booking-rules.js';

const page = JSON.parse(document.querySelector('#page-settings').textContent);
const vehicle = page.vehicle;
const canonical = document.querySelector('link[rel="canonical"]')?.href;

const contactEvents = {
  telegram: 'contact_telegram', whatsapp: 'contact_whatsapp',
  phone: 'contact_phone', avito: 'contact_avito'
};
const settings = document.querySelector('#analytics-settings');
const consentKey = 'autovau.analytics';
let active = false;
let consent;
try { consent = localStorage.getItem(consentKey); } catch { /* Обходиться без хранилища. */ }

function sendGoal(name) {
  if (!active) return;
  const params = vehicle ? {vehicle_id: vehicle.id} : {};
  window.ym(page.counterId, 'reachGoal', name, params);
}

function enableAnalytics() {
  try {
    window.ym ||= function () { (window.ym.a ||= []).push(arguments); };
    window.ym.l = Date.now();
    window.ym(page.counterId, 'init', {
      defer: true, clickmap: false, trackLinks: false, webvisor: false,
      accurateTrackBounce: false, trackHash: false
    });
    if (canonical) window.ym(page.counterId, 'hit', canonical, {referer: ''});
    active = true;
    if (vehicle) sendGoal('vehicle_view');
    const tag = document.createElement('script');
    tag.async = true;
    tag.src = 'https://mc.yandex.ru/metrika/tag.js';
    document.head.append(tag);
  } catch { active = false; }
}

if (page.counterId && settings) {
  const controls = document.querySelector('#analytics-consent');
  function showConsent() { controls.showModal(); }
  settings.addEventListener('click', showConsent);
  controls.addEventListener('close', () => {
    const choice = controls.returnValue;
    controls.returnValue = '';
    if (choice !== 'allow' && choice !== 'deny') return;
    try { localStorage.setItem(consentKey, choice); } catch { /* Только текущая страница. */ }
    consent = choice;
    if (choice === 'allow' && !active) enableAnalytics();
    if (choice === 'deny' && active) {
      active = false;
      location.reload();
    }
  });
  if (consent === 'allow') enableAnalytics();
  else if (consent !== 'deny') showConsent();
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[data-contact]');
  if (link && contactEvents[link.dataset.contact]) sendGoal(contactEvents[link.dataset.contact]);
});

for (const link of document.querySelectorAll('a[data-contact="telegram"], a[data-contact="whatsapp"]')) {
  link.href = contactUrl(link.href, message(vehicle));
}

const dialog = document.querySelector('#booking-dialog');
const source = document.querySelector('.contact-options--booking, .contact-options--footer');
if (dialog && source) {
  const panel = dialog.querySelector('.booking-dialog__panel');
  const close = dialog.querySelector('.booking-dialog__close');
  const title = dialog.querySelector('#booking-title');
  const fields = dialog.querySelector('#booking-dates');
  const start = fields?.querySelector('#booking-start');
  const end = fields?.querySelector('#booking-end');
  const result = fields?.querySelector('#booking-quote');
  const contacts = source.cloneNode(true);
  contacts.className = 'contact-options';
  contacts.querySelector('.contact-options__title').remove();
  panel.append(contacts);
  const messengers = [...contacts.querySelectorAll('[data-contact="telegram"],[data-contact="whatsapp"]')];
  const originals = messengers.map(link => link.href);
  const rubles = new Intl.NumberFormat('ru-RU');
  let opener;
  let booking = false;
  let outside = false;
  let lastPrice = '';

  function refresh(track = false) {
    const assessment = booking ? quote(start.value, end.value, vehicle) : {state: 'empty'};
    const notices = {
      empty: '', incomplete: 'Укажите обе даты для расчёта.', invalid: 'Проверьте выбранные даты.',
      past: 'Дата начала не может быть в прошлом.',
      order: 'Дата окончания должна быть позже даты начала.',
      minimum: assessment.state === 'minimum' ? `Выбранный срок: ${rentalDays(assessment.days)}. Минимальный срок аренды — ${rentalDays(vehicle.minimum_days)}.` : '',
      unknown: assessment.days ? `${rentalDays(assessment.days)}. Уточните стоимость у владельца.` : '',
      priced: assessment.days ? `${rentalDays(assessment.days)} · предварительно ${rubles.format(assessment.total)} ₽ за аренду.` : ''
    };
    if (result) result.textContent = notices[assessment.state];
    if (booking) {
      start.setAttribute('aria-invalid', String(['invalid', 'past'].includes(assessment.state)));
      end.setAttribute('aria-invalid', String(['invalid', 'order', 'minimum'].includes(assessment.state)));
    }
    const body = message(booking ? vehicle : null, start?.value, end?.value, assessment);
    messengers.forEach((link, index) => { link.href = contactUrl(originals[index], body); });
    if (track) {
      sendGoal('booking_dates');
      const pair = start.value + '/' + end.value;
      if (assessment.state === 'priced' && pair !== lastPrice) sendGoal('booking_quote');
      lastPrice = assessment.state === 'priced' ? pair : '';
    }
  }

  for (const trigger of document.querySelectorAll('.booking-trigger')) {
    trigger.addEventListener('click', () => {
      if (document.querySelector('dialog[open]')) return;
      opener = trigger;
      outside = false;
      booking = Boolean(vehicle && !trigger.hasAttribute('data-general-contact'));
      title.textContent = booking ? 'Забронировать автомобиль' : 'Выберите способ связи';
      if (fields) fields.hidden = !booking;
      const model = dialog.querySelector('#booking-model');
      if (model) model.hidden = !booking;
      dialog.setAttribute('aria-labelledby', booking ? 'booking-title booking-model' : 'booking-title');
      if (booking) start.min = todayInMoscow();
      refresh();
      dialog.showModal();
      document.documentElement.classList.add('booking-open');
      close.focus({preventScroll: true});
      if (booking) sendGoal('booking_open');
    });
  }
  fields?.addEventListener('input', () => refresh(true));
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('pointerdown', event => { outside = event.target === dialog; });
  dialog.addEventListener('click', event => {
    if (outside && event.target === dialog) dialog.close();
    outside = false;
  });
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('booking-open');
    opener?.focus({preventScroll: true});
  });
}

const share = document.querySelector('#vehicle-share');
if (share && canonical) {
  const status = document.querySelector('#share-status');
  const manual = document.querySelector('#share-manual');
  share.hidden = false;
  share.addEventListener('click', async () => {
    sendGoal('vehicle_share');
    status.textContent = '';
    manual.hidden = true;
    try {
      if (navigator.share) {
        await navigator.share({title: document.title, url: canonical});
        return;
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(canonical);
      status.textContent = 'Ссылка скопирована.';
    } catch {
      manual.value = canonical;
      manual.hidden = false;
      manual.focus();
      manual.select();
      status.textContent = 'Скопируйте выделенную ссылку.';
    }
  });
}
