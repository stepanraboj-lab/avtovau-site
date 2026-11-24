(() => {
  const dialog = document.querySelector('#photo-viewer');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  const links = [...document.querySelectorAll('[data-photo-index]')];
  const photos = [...document.querySelectorAll('.gallery [data-photo-index]')];
  if (!photos.length) return;

  const stage = dialog.querySelector('.photo-viewer__stage');
  const counter = dialog.querySelector('.photo-viewer__counter');
  const strip = dialog.querySelector('.photo-viewer__thumbs');
  const close = dialog.querySelector('.photo-viewer__close');
  const previous = dialog.querySelector('.photo-viewer__previous');
  const next = dialog.querySelector('.photo-viewer__next');
  const reset = dialog.querySelector('.photo-viewer__reset');
  const error = dialog.querySelector('.photo-viewer__error');
  const image = new Image();
  image.className = 'photo-viewer__image';
  image.draggable = false;
  image.hidden = true;
  stage.append(image);

  const root = document.documentElement;
  let index = 0;
  let opener;
  let scroll;
  let scale = 1;
  let x = 0;
  let y = 0;
  let thumbnails = [];

  function transform(value, left, top) {
    scale = Math.max(1, Math.min(4, value));
    const limitX = Math.max(0, (image.offsetWidth * scale - stage.clientWidth) / 2);
    const limitY = Math.max(0, (image.offsetHeight * scale - stage.clientHeight) / 2);
    x = Math.max(-limitX, Math.min(limitX, left));
    y = Math.max(-limitY, Math.min(limitY, top));
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    image.classList.toggle('is-zoomed', scale > 1);
  }

  function resetZoom() {
    transform(1, 0, 0);
  }

  function zoomTo(value, from, to = from) {
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const ratio = Math.max(1, Math.min(4, value)) / scale;
    transform(
      value,
      to.x - centerX - (from.x - centerX - x) * ratio,
      to.y - centerY - (from.y - centerY - y) * ratio
    );
  }

  function makeThumbnails() {
    thumbnails = photos.map((photo, i) => {
      const button = document.createElement('button');
      const thumb = new Image();
      thumb.src = photo.dataset.thumbnail || photo.href;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.draggable = false;
      button.type = 'button';
      button.className = 'photo-viewer__thumbnail';
      button.setAttribute('aria-label', `Фото ${i + 1}: ${photo.querySelector('img').alt}`);
      button.addEventListener('click', () => select(i));
      button.append(thumb);
      return button;
    });
    strip.append(...thumbnails);
  }

  function select(position) {
    index = (position + photos.length) % photos.length;
    const link = photos[index];
    clearPointers();
    resetZoom();
    error.hidden = true;
    image.hidden = true;
    image.alt = link.querySelector('img').alt;
    image.src = link.href;
    if (image.complete && image.naturalWidth) image.hidden = false;
    counter.textContent = `${index + 1} / ${photos.length}`;
    thumbnails.forEach((button, i) => {
      if (i === index) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    const selected = thumbnails[index];
    if (selected && strip.clientWidth) {
      const frame = strip.getBoundingClientRect();
      const thumb = selected.getBoundingClientRect();
      if (thumb.left < frame.left) strip.scrollLeft += thumb.left - frame.left;
      if (thumb.right > frame.right) strip.scrollLeft += thumb.right - frame.right;
    }
  }

  image.addEventListener('load', () => { image.hidden = false; });
  image.addEventListener('error', () => {
    image.hidden = true;
    error.hidden = false;
  });
  previous.hidden = next.hidden = photos.length === 1;
  const desktop = matchMedia('(min-width: 768px) and (hover: hover) and (pointer: fine)');
  function prepareThumbnails() {
    if (dialog.open && desktop.matches && !thumbnails.length) {
      makeThumbnails();
      thumbnails[index].setAttribute('aria-current', 'true');
    }
  }
  desktop.addEventListener('change', prepareThumbnails);

  for (const link of links) {
    link.setAttribute('aria-haspopup', 'dialog');
    link.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey ||
          event.shiftKey || event.altKey || opener || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      opener = link;
      scroll = { left: window.scrollX, top: window.scrollY };
      root.style.setProperty('--photo-viewer-scroll-top', `${-scroll.top}px`);
      root.style.setProperty('--photo-viewer-scroll-left', `${-scroll.left}px`);
      root.classList.add('photo-viewer-open');
      dialog.showModal();
      prepareThumbnails();
      select(Number(link.dataset.photoIndex));
      close.focus({preventScroll: true});
    });
  }

  close.addEventListener('click', () => dialog.close());
  reset.addEventListener('click', resetZoom);
  previous.addEventListener('click', () => select(index - 1));
  next.addEventListener('click', () => select(index + 1));
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.matches(
      '.photo-viewer__layout, .photo-viewer__bar, .photo-viewer__main, .photo-viewer__thumbs'
    )) dialog.close();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    select(index + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  dialog.addEventListener('close', () => {
    clearPointers();
    root.classList.remove('photo-viewer-open');
    root.style.removeProperty('--photo-viewer-scroll-top');
    root.style.removeProperty('--photo-viewer-scroll-left');
    window.scrollTo({ ...scroll, behavior: 'instant' });
    opener.focus({preventScroll: true});
    opener = undefined;
  });
  new ResizeObserver(() => {
    if (dialog.open) transform(scale, x, y);
  }).observe(stage);

  const pointers = new Map();
  let first;
  let multi = false;
  let moved = false;
  let lastTap;

  function clearPointers() {
    for (const id of pointers.keys()) {
      if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    }
    pointers.clear();
    lastTap = undefined;
  }

  function point(event) {
    return { x: event.clientX, y: event.clientY };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onPhoto(p) {
    const rect = image.getBoundingClientRect();
    return !image.hidden && p.x >= rect.left && p.x <= rect.right &&
      p.y >= rect.top && p.y <= rect.bottom;
  }

  // Гасим нативный жест только на фото, чтобы он не подавлял следующее касание кнопки.
  stage.addEventListener('touchmove', event => event.preventDefault(), {passive: false});

  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointers.size >= 2) return;
    const p = point(event);
    if (!pointers.size) {
      first = { ...p, onPhoto: onPhoto(p) };
      multi = moved = false;
    } else {
      multi = true;
      lastTap = undefined;
    }
    pointers.set(event.pointerId, p);
    stage.setPointerCapture(event.pointerId);
  });

  stage.addEventListener('pointermove', event => {
    const old = pointers.get(event.pointerId);
    if (!old) return;
    const current = point(event);
    pointers.set(event.pointerId, current);
    if (distance(first, current) > 8) moved = true;
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      const span = distance(old, other);
      if (span > 0) zoomTo(scale * distance(current, other) / span, midpoint(old, other), midpoint(current, other));
    } else if (scale > 1 && moved) {
      transform(scale, x + current.x - old.x, y + current.y - old.y);
    }
  });

  stage.addEventListener('pointercancel', event => {
    pointers.delete(event.pointerId);
    lastTap = undefined;
    multi = true;
  });

  stage.addEventListener('pointerup', event => {
    if (!pointers.delete(event.pointerId) || pointers.size) return;
    const end = point(event);
    const dx = end.x - first.x;
    const dy = end.y - first.y;
    if (!multi && scale === 1 && Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      select(index + (dx < 0 ? 1 : -1));
    } else if (!multi && !moved && distance(first, end) <= 8) {
      if (!first.onPhoto && !onPhoto(end)) {
        dialog.close();
      } else if (first.onPhoto && onPhoto(end)) {
        const now = performance.now();
        if (lastTap && now - lastTap.time < 350 && distance(lastTap, end) < 30) {
          if (scale > 1) resetZoom();
          else zoomTo(2.5, end);
          lastTap = undefined;
        } else {
          lastTap = { ...end, time: now };
        }
      }
    } else {
      lastTap = undefined;
    }
  });
})();
