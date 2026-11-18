'use strict';
window.popup.onData((d) => {
  document.getElementById('title').textContent = d.title;
  document.getElementById('body').textContent = d.body;
  document.getElementById('more').textContent = d.note ? d.note : d.count > 1 ? `${d.count} new messages · click to open` : 'Click to open and reply';
  // replay the small attention animations for every new message
  for (const [el, cls] of [[document.querySelector('.text'), 'pulse'], [document.getElementById('icon'), 'ring']]) {
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  }
});
document.body.addEventListener('click', () => window.popup.open());
document.getElementById('close').addEventListener('click', (e) => { e.stopPropagation(); window.popup.close(); });
