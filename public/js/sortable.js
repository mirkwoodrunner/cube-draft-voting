/**
 * Touch- and mouse-friendly sortable list built on Pointer Events.
 * Items need a data-id and a child with data-handle to grab. Only the handle
 * captures touch, so the rest of the page still scrolls normally.
 */
function makeSortable(container, onChange) {
  let drag = null;
  let raf = null;

  function place() {
    if (!drag) return;
    const { item, offsetY } = drag;
    const others = [...container.children].filter((c) => c !== item);
    const height = item.offsetHeight;
    item.style.transform = '';
    const desiredTop = drag.lastY - offsetY;
    const center = desiredTop + height / 2;
    let before = null;
    for (const o of others) {
      const r = o.getBoundingClientRect();
      if (center < r.top + r.height / 2) { before = o; break; }
    }
    if (before !== item.nextElementSibling) container.insertBefore(item, before);
    const naturalTop = item.getBoundingClientRect().top;
    item.style.transform = `translateY(${desiredTop - naturalTop}px)`;
  }

  function loop() {
    if (!drag) return;
    const margin = 70;
    if (drag.lastY < margin) window.scrollBy(0, -14);
    else if (drag.lastY > window.innerHeight - margin) window.scrollBy(0, 14);
    place();
    raf = requestAnimationFrame(loop);
  }

  function end() {
    if (!drag) return;
    cancelAnimationFrame(raf);
    place();
    const { item } = drag;
    item.style.transform = '';
    item.classList.remove('sortable-dragging');
    drag = null;
    onChange();
  }

  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-handle]');
    if (!handle || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const item = handle.closest('[data-id]');
    if (!item || item.parentElement !== container) return;
    e.preventDefault();
    // Capture on the list, not the handle: reordering moves the handle in the DOM, which would drop its capture.
    container.setPointerCapture(e.pointerId);
    drag = { item, offsetY: e.clientY - item.getBoundingClientRect().top, lastY: e.clientY, pointerId: e.pointerId };
    item.classList.add('sortable-dragging');
    raf = requestAnimationFrame(loop);
  });
  container.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.pointerId) {
      drag.lastY = e.clientY;
      place();
    }
  });
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
  container.addEventListener('lostpointercapture', end);
}

/** Move an item one step (keyboard / button fallback). */
function moveItem(item, delta) {
  const parent = item.parentElement;
  if (delta < 0 && item.previousElementSibling) parent.insertBefore(item, item.previousElementSibling);
  else if (delta > 0 && item.nextElementSibling) parent.insertBefore(item.nextElementSibling, item);
}
