// tells the host how tall the page's content is, for its window to fit it.
// Measuring forces layout there and then, so it works in a window that's
// still hidden - which may render no frames, and so hear nothing from a
// ResizeObserver - while the observer covers changes once it's shown.
let reported = 0;

export function reportHeight() {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height === 0 || height === reported) return;
  reported = height;
  window.cmdless.view.notify.resize({ height });
}

new ResizeObserver(reportHeight).observe(document.body);
