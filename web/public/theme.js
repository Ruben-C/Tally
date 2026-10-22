// Applies saved display preferences before first paint (external file so the CSP needs no inline script).
try {
  var d = document.documentElement;
  var t = localStorage.getItem('tally-theme');
  if (t === 'light' || t === 'dark') d.dataset.theme = t;
  var a = localStorage.getItem('tally-accent');
  if (a && a !== 'blue') d.dataset.accent = a;
  var n = localStorage.getItem('tally-density');
  if (n === 'compact' || n === 'comfortable') d.dataset.density = n;
  if (localStorage.getItem('tally-privacy') === 'on') d.dataset.privacy = 'on';
} catch (e) {}
