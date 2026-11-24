import {contactUrl, message, quote, rentalDays, rubles, todayInMoscow} from './booking-rules.js';
import {setupAnalytics} from './analytics.js';

const page = JSON.parse(document.querySelector('#page-settings').textContent);
const vehicle = page.vehicle;
const canonical = document.querySelector('link[rel="canonical"]')?.href;

const contactEvents = {
  telegram: 'contact_telegram', whatsapp: 'contact_whatsapp',
  phone: 'contact_phone', avito: 'contact_avito'
};
const sendGoal = setupAnalytics(page.counterId, canonical, vehicle);

for (const year of document.querySelectorAll('[data-copy-year]')) {
  year.textContent = new Intl.DateTimeFormat('ru-RU', {year: 'numeric', timeZone: 'Europe/Moscow'}).format(new Date());
}
for (const button of document.querySelectorAll('button[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const value = document.getElementById(button.dataset.copy);
    const status = document.querySelector('#copy-status');
    try {
      await navigator.clipboard.writeText(value.textContent.trim());
      status.textContent = 'Скопировано.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(value);
      value.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Номер выделен. Скопируйте его из выделения.';
    }
  });
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[data-contact]');
  if (link && contactEvents[link.dataset.contact]) sendGoal(contactEvents[link.dataset.contact], true);
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
  const breakdown = fields?.querySelector('#booking-breakdown');
  const amounts = breakdown?.querySelectorAll('[data-amount]');
  const contacts = source.cloneNode(true);
  contacts.className = 'contact-options';
  contacts.querySelector('.contact-options__title').remove();
  panel.append(contacts);
  const messengers = [...contacts.querySelectorAll('[data-contact="telegram"],[data-contact="whatsapp"]')];
  const originals = messengers.map(link => link.href);
  let opener;
  let booking = false;
  let outside = false;
  let lastTrackedDates;
  const trackedQuotes = new Set();

  function refresh(track = false) {
    const assessment = booking ? quote(start.value, end.value, vehicle) : {state: 'empty'};
    const notices = {
      empty: '', incomplete: 'Укажите обе даты для расчёта.', invalid: 'Проверьте выбранные даты.',
      past: 'Дата начала не может быть в прошлом.',
      order: 'Дата окончания должна быть позже даты начала.',
      minimum: assessment.state === 'minimum' ? `Выбранный срок: ${rentalDays(assessment.days)}. Минимальный срок аренды — ${rentalDays(vehicle.minimum_days)}.` : '',
      unknown: assessment.days ? `${rentalDays(assessment.days)}. Уточните стоимость у владельца.` : '',
      priced: 'Предварительный расчёт'
    };
    if (result) result.textContent = notices[assessment.state];
    if (breakdown) {
      breakdown.hidden = assessment.state !== 'priced';
      if (!breakdown.hidden) for (const amount of amounts) {
        const key = amount.dataset.amount;
        amount.textContent = key === 'days' ? rentalDays(assessment.days) : rubles(assessment[key]);
      }
    }
    if (booking) {
      start.setAttribute('aria-invalid', String(['invalid', 'past'].includes(assessment.state)));
      end.setAttribute('aria-invalid', String(['invalid', 'order', 'minimum'].includes(assessment.state)));
    }
    const body = message(booking ? vehicle : null, start?.value, end?.value, assessment);
    messengers.forEach((link, index) => { link.href = contactUrl(originals[index], body); });
    if (track && (assessment.state === 'priced' || assessment.state === 'unknown')) {
      const pair = start.value + '/' + end.value;
      if (pair !== lastTrackedDates && sendGoal('booking_dates')) lastTrackedDates = pair;
      if (assessment.state === 'priced' && !trackedQuotes.has(pair) && sendGoal('booking_quote')) {
        trackedQuotes.add(pair);
      }
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
      if (booking) sendGoal('booking_open', true);
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
  let sharing = false;
  share.hidden = false;
  share.addEventListener('click', async () => {
    if (sharing) return;
    sharing = true;
    status.textContent = '';
    manual.hidden = true;
    try {
      if (navigator.share) {
        try {
          await navigator.share({title: document.title, url: canonical});
          sendGoal('vehicle_share', true);
          return;
        } catch (error) {
          if (error.name === 'AbortError') return;
        }
      }
      try {
        await navigator.clipboard.writeText(canonical);
        sendGoal('vehicle_share', true);
        status.textContent = 'Ссылка скопирована.';
      } catch {
        manual.value = canonical;
        manual.hidden = false;
        manual.focus();
        manual.select();
        status.textContent = 'Скопируйте выделенную ссылку.';
      }
    } finally {
      sharing = false;
    }
  });
}
