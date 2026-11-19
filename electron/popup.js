'use strict';
window.popup.onData((d) => {
  const root = document.documentElement;
  if (d.accent) root.style.setProperty('--accent', d.accent);
  root.classList.toggle('light', !!d.light);
  root.classList.toggle('still', d.motion === false);
  root.style.zoom = d.scale && d.scale !== 1 ? String(d.scale) : '';
  document.body.dataset.design = d.design || 'glass';
  document.getElementById('title').textContent = d.title;
  document.getElementById('body').textContent = d.body;
  document.getElementById('more').textContent = d.note ? d.note : d.count > 1 ? `${d.count} new messages · click to open` : 'Click to open and reply';
  // replay the small attention animations for every new message
  for (const [el, cls] of [[document.querySelector('.text'), 'pulse'], [document.getElementById('icon'), 'ring'], [document.getElementById('card'), 'shine']]) {
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  }
});
document.getElementById('card').addEventListener('click', () => window.popup.open());
document.getElementById('close').addEventListener('click', (e) => { e.stopPropagation(); window.popup.close(); });
