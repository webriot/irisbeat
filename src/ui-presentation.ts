// SPDX-License-Identifier: AGPL-3.0-only
export const timeMarkup = (at: number) => {
  const iso = new Date(at).toISOString();
  return `<time datetime="${iso}">${iso}</time>`;
};

export const presentationScript = `
window.IrisbeatPresentation = (() => {
  const instant = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' });
  const bucket = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  // Monitor identity and UTC date survive replacement nodes and midnight rollover.
  const selectedDays = new Map();
  function initialize(root = document) {
    root.querySelectorAll('time[datetime]').forEach(time => {
      time.textContent = instant.format(new Date(time.dateTime));
    });
    root.querySelectorAll('.history').forEach(strip => {
      const buttons = [...strip.querySelectorAll('button[data-date]')];
      const id = strip.dataset.historyId;
      const detail = strip.parentElement.querySelector('.history-detail');
      function select(button) {
        selectedDays.set(id, button.dataset.date);
        buttons.forEach(day => {
          day.tabIndex = day === button ? 0 : -1;
          day.setAttribute('aria-pressed', String(day === button));
        });
        if (detail.textContent !== button.getAttribute('aria-label')) detail.textContent = button.getAttribute('aria-label');
      }
      buttons.forEach((button, index) => {
        const start = new Date(button.dataset.date + 'T00:00:00Z');
        const end = new Date(start.getTime() + 86400000);
        button.setAttribute('aria-label', bucket.format(start) + ' UTC: ' + button.dataset.summary + '; ' + instant.format(start) + ' — ' + instant.format(end));
        button.onfocus = () => select(button);
        button.onclick = () => { select(button); button.focus(); };
        button.onkeydown = event => {
          const target = event.key === 'ArrowLeft' ? Math.max(0, index - 1)
            : event.key === 'ArrowRight' ? Math.min(buttons.length - 1, index + 1)
            : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
          if (target !== null) { event.preventDefault(); buttons[target].focus(); }
        };
      });
      const selected = buttons.find(button => button.dataset.date === selectedDays.get(id)) || buttons.at(-1);
      if (selected) select(selected);
    });
  }
  initialize();
  return { initialize, clear: () => selectedDays.clear() };
})();
`;
