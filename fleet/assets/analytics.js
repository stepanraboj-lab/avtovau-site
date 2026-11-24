const consentKey = 'autovau.analytics.v3';
const campaignKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'yclid'];
const campaignValue = /^[\p{L}\p{N} _.,+:/()\-]{1,120}$/u;
const phoneOrDocumentNumber = /\d(?:[ ().+\-]*\d){9}/;

function savedConsent() {
  try {
    return localStorage.getItem(consentKey);
  } catch {
    return undefined;
  }
}

function saveConsent(choice) {
  try {
    localStorage.setItem(consentKey, choice);
  } catch {
    if (choice === 'deny') {
      try { localStorage.removeItem(consentKey); } catch { /* Хранилище недоступно. */ }
    }
  }
  return savedConsent() === choice;
}

function landing(canonical) {
  const current = new URL(location.href);
  const labels = new URLSearchParams();
  for (const key of campaignKeys) {
    const values = current.searchParams.getAll(key);
    if (values.length !== 1) continue;
    const value = values[0].trim();
    const valid = key === 'yclid' ? /^\d{1,24}$/.test(value)
      : campaignValue.test(value) && !phoneOrDocumentNumber.test(value) && !/^\d{7,}$/.test(value);
    if (valid) labels.set(key, value);
  }
  const url = new URL(canonical);
  url.search = current.search = labels.toString();
  current.hash = '';
  if (current.href !== location.href) history.replaceState(history.state, '', current.href);
  return url.href;
}

function referralOrigin() {
  if (!document.referrer) return '';
  const url = new URL(document.referrer);
  return ['http:', 'https:'].includes(url.protocol) ? url.origin + '/' : '';
}

export function setupAnalytics(counterId, canonical, vehicle) {
  const settings = document.querySelector('#analytics-settings');
  const notice = document.querySelector('#analytics-consent');
  let active = false;
  let script;
  let openedFromFooter = false;
  const recent = new Map();
  const status = notice.querySelector('[role="status"]');

  function sendGoal(name, suppressRepeat = false) {
    if (!active || !checkConsent()) return false;
    const now = performance.now();
    if (suppressRepeat && now - (recent.get(name) ?? -Infinity) < 650) return false;
    window.ym(counterId, 'reachGoal', name, vehicle ? {vehicle_id: vehicle.id} : {});
    if (suppressRepeat) recent.set(name, now);
    return true;
  }

  function enable() {
    if (active || !counterId || savedConsent() !== 'allow') return;
    try {
      const url = landing(canonical);
      const referer = referralOrigin();
      window.ym ||= function () { (window.ym.a ||= []).push(arguments); };
      window.ym.l = Date.now();
      window.ym(counterId, 'init', {
        defer: true, clickmap: false, trackLinks: false, webvisor: false,
        accurateTrackBounce: false, trackHash: false
      });
      window.ym(counterId, 'hit', url, {referer});
      active = true;
      if (vehicle) sendGoal('vehicle_view');
      script = document.createElement('script');
      script.async = true;
      script.referrerPolicy = 'origin';
      script.src = 'https://mc.yandex.ru/metrika/tag.js';
      document.head.append(script);
    } catch {
      revoke();
    }
  }

  function clearAnalyticsCookies() {
    const siteHost = new URL(canonical).hostname;
    const domains = ['', location.hostname, siteHost].filter((host, i, values) =>
      values.indexOf(host) === i && (!host || location.hostname === host || location.hostname.endsWith('.' + host))
    );
    for (const entry of document.cookie.split(';')) {
      const name = entry.trim().split('=')[0];
      if (!/^_ym_[a-z0-9_]+$/i.test(name)) continue;
      for (const domain of domains) {
        document.cookie = name + '=; Max-Age=0; Path=/' + (domain ? '; Domain=' + domain : '');
      }
    }
  }

  function revoke() {
    const wasActive = active;
    active = false;
    script?.remove();
    if (window.ym?.a) window.ym.a.length = 0;
    if (wasActive) {
      try { window['yaCounter' + counterId]?.destruct?.(); } catch { /* Штатная перезагрузка остановит счётчик. */ }
    }
    if (canonical) clearAnalyticsCookies();
    const choice = savedConsent();
    if (wasActive && choice !== undefined && choice !== 'allow') location.reload();
  }

  function checkConsent() {
    if (savedConsent() === 'allow') return true;
    if (active) revoke();
    return false;
  }

  function showNotice() {
    notice.hidden = false;
    settings.setAttribute('aria-expanded', 'true');
  }
  function hideNotice() {
    notice.hidden = true;
    settings.setAttribute('aria-expanded', 'false');
    if (openedFromFooter) settings.focus();
    openedFromFooter = false;
  }

  settings.hidden = false;
  settings.addEventListener('click', () => {
    if (openedFromFooter && !notice.hidden) {
      hideNotice();
      return;
    }
    openedFromFooter = true;
    settings.closest('footer').before(notice);
    showNotice();
    notice.focus();
  });
  notice.addEventListener('click', event => {
    const choice = event.target.closest('button[data-consent]')?.dataset.consent;
    if (choice === 'dismiss') hideNotice();
    if (!counterId || (choice !== 'allow' && choice !== 'deny')) return;
    const persisted = saveConsent(choice);
    if (choice === 'deny') revoke();
    if (!persisted) {
      status.hidden = false;
      status.textContent = choice === 'allow'
        ? 'Браузер не сохранил согласие. Аналитика не включена.'
        : 'Браузер не сохранил отказ. Аналитика остановлена в этой вкладке.';
      return;
    }
    status.hidden = true;
    hideNotice();
    if (choice === 'allow') enable();
  });

  if (counterId) {
    const choice = savedConsent();
    if (choice === 'allow') enable();
    else if (choice === 'deny') clearAnalyticsCookies();
    else showNotice();

    window.addEventListener('storage', event => {
      if (event.key === consentKey || event.key === null) checkConsent();
    });
    window.addEventListener('pageshow', checkConsent);
    document.addEventListener('visibilitychange', checkConsent);
  }
  return sendGoal;
}
