/**
 * The web tool's only script. Everything works without it; it adds:
 *   - auto-refresh of each panel's chart (no model is involved: the server
 *     re-runs the saved query);
 *   - submitting the time range when it changes;
 *   - the endpoint picker's filter box.
 */
export const CLIENT_SCRIPT = String.raw`
(() => {
  const main = document.querySelector('[data-dashboard]') || document.querySelector('[data-share]');
  const status = document.querySelector('[data-refresh-status]');
  const toggle = document.querySelector('[data-auto-refresh]');
  if (main) {
    const id = main.dataset.dashboard;
    const range = main.dataset.range;
    const seconds = Number(main.dataset.refreshSeconds || 30);
    const refresh = async () => {
      if (toggle && !toggle.checked) return;
      const panels = [...document.querySelectorAll('[data-panel]')];
      await Promise.all(panels.map(async (panel) => {
        try {
          const base = main.dataset.share ? '/share/' + main.dataset.share : '/dashboards/' + id;
          const response = await fetch(base + '/panels/' + panel.dataset.panel + '/chart?range=' + encodeURIComponent(range), { credentials: 'same-origin' });
          if (response.ok) panel.querySelector('[data-chart]').innerHTML = await response.text();
        } catch {}
      }));
      if (status) status.textContent = 'Updated ' + new Date().toLocaleTimeString() + ' · refreshes every ' + seconds + ' s';
    };
    setInterval(refresh, seconds * 1000);
  }
  const switchForm = document.querySelector('[data-switch-form]');
  switchForm?.querySelector('select')?.addEventListener('change', () => switchForm.submit());
  const rangeForm = document.querySelector('[data-range-form]');
  rangeForm?.querySelector('select')?.addEventListener('change', () => rangeForm.submit());
  const filter = document.getElementById('ep-filter');
  const list = document.querySelector('[data-endpoints]');
  filter?.addEventListener('input', () => {
    const wanted = filter.value.trim().toLowerCase();
    for (const label of list.querySelectorAll('label')) {
      label.hidden = wanted !== '' && !label.textContent.toLowerCase().includes(wanted);
    }
  });
})();
`;
