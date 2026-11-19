// SPDX-License-Identifier: AGPL-3.0-only
import type { NotificationDestination } from './notification-jobs';
import type { Monitor } from './monitor-configuration';
import type { createOperatorSession, SchedulePreview } from './operator-session';

type EditorSession = Pick<ReturnType<typeof createOperatorSession>, 'preview' | 'cancelPreview' | 'run'>;
type EditableMonitor = Pick<Monitor, 'id' | 'name' | 'kind'> & Partial<Omit<Monitor, 'id' | 'name' | 'kind'>> & { destinationIds?: string[]; scheduleSuspended?: boolean };

// Describe only the DOM members used here, without mixing browser globals into Worker types.
type EditorControl = {
  id: string; value: string; type: string; name: string; className: string; checked: boolean; disabled: boolean; hidden: boolean;
  min: string; max: string; textContent: string | null;
  setCustomValidity(message: string): void;
  reportValidity(): boolean;
  setAttribute(name: string, value: string): void;
  closest(selector: string): { hidden: boolean } | null;
  focus(): void;
  append(...nodes: unknown[]): void;
  querySelector(selector: string): EditorControl | null;
  replaceChildren(...nodes: unknown[]): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
};
type PreviewElement = { dataset: Record<string, string>; dateTime: string; textContent: string | null; append(...nodes: PreviewElement[]): void };
type EditorForm = {
  hidden: boolean;
  reset(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  querySelectorAll(selector: string): Iterable<EditorControl>;
  ownerDocument: {
    defaultView: { confirm(message: string): boolean } | null;
    getElementById(id: string): unknown;
    querySelector(selector: string): { hidden: boolean; textContent: string | null } | null;
    createElement(tag: "label" | "input" | "span"): EditorControl;
    createElement(tag: string): PreviewElement;
    activeElement: EditorControl;
  };
};

// Self-contained: ui.tsx embeds this factory into the classic Operator script.
export function createMonitorEditor(form: EditorForm, session: EditorSession, focusActions: (id: string | null) => void, reconcileNodes: (container: EditorControl, nodes: EditorControl[]) => void) {
  const document = form.ownerDocument;
  const timingDefaults = { intervalSeconds: 60, timeoutSeconds: 10, failureThreshold: 2, recoveryThreshold: 2, silenceSeconds: 180, recoverySpacingSeconds: 60, graceSeconds: 30 };
  type TimingField = keyof typeof timingDefaults;
  const durationFactors = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };
  type DurationUnit = keyof typeof durationFactors;
  const durations = new Map<EditorControl, { control: EditorControl; min: number; max: number; unit: DurationUnit; seconds: number; display: string }>();
  let editingId: string | null = null;
  let minimumCheckInterval = timingDefaults.intervalSeconds;
  let savedInterval: number | undefined;
  let savedCalendar: { cron: string; timezone: string } | undefined;
  let scheduleSuspended = false;
  let newIntervalDefault = timingDefaults.intervalSeconds;
  let monitorIds = new Set<string>();
  let destinations: NotificationDestination[] = [];
  let savedSelections = new Set<string>();
  const selectionChanges = new Map<string, boolean>();
  const controls = {
    get(id: string): EditorControl { return document.getElementById(id) as EditorControl; },
    fields(): TimingField[] {
      const heartbeat = controls.get('kind').value === 'heartbeat';
      const calendar = controls.get('scheduleMode').value === 'calendar';
      return (Object.keys(timingDefaults) as TimingField[]).filter(field => {
        if (field === 'intervalSeconds') return !calendar;
        if (field === 'recoveryThreshold') return true;
        if (field === 'graceSeconds') return heartbeat && calendar;
        if (field === 'silenceSeconds' || field === 'recoverySpacingSeconds') return heartbeat && !calendar;
        return !heartbeat;
      });
    },
    outboundIntervalMinimum() {
      return controls.get('kind').value === 'heartbeat' ? timingDefaults.intervalSeconds : minimumCheckInterval;
    },
    calendarUnchanged() {
      return savedCalendar !== undefined && controls.get('scheduleMode').value === 'calendar' &&
        savedCalendar.cron === controls.get('cron').value && savedCalendar.timezone === controls.get('timezone').value;
    },
    preview() {
      controls.get('resume-schedule').hidden = true;
      controls.get('cron').setCustomValidity('');
      controls.get('schedule-explanation').textContent = '';
      controls.get('schedule-occurrences').replaceChildren();
      const cron = controls.get('cron').value;
      const timezone = controls.get('timezone').value;
      const heartbeat = controls.get('kind').value === 'heartbeat';
      session.preview(controls.get('scheduleMode').value !== 'calendar' ? null : () => ({
        cron, timezone, ...(heartbeat ? { graceSeconds: duration.validate(controls.get('graceSeconds')) } : { outbound: true }),
      }));
    },
  };
  const duration = {
    seconds(input: EditorControl) {
      const state = durations.get(input)!;
      // Keep the original seconds when a unit has a repeating decimal representation.
      if (input.value === state.display) return state.seconds;
      const match = input.value.match(/^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
      if (!match || !(match[1] + (match[2] || '')) || !Number.isFinite(Number(input.value))) return null;
      const exponent = Number(match[3] || 0) - (match[2] || '').length;
      if (Math.abs(exponent) > 400) return null;
      const numerator = BigInt(match[1] + (match[2] || '')) * BigInt(durationFactors[state.unit]) * 10n ** BigInt(Math.max(0, exponent));
      const denominator = 10n ** BigInt(Math.max(0, -exponent));
      if (numerator % denominator !== 0n) return null;
      const seconds = Number(numerator / denominator);
      return Number.isSafeInteger(seconds) && seconds >= state.min && seconds <= state.max ? seconds : null;
    },
    validate(input: EditorControl) {
      const seconds = duration.seconds(input);
      const state = durations.get(input)!;
      if (input.id === 'intervalSeconds' && seconds !== null && seconds < controls.outboundIntervalMinimum() && seconds !== savedInterval) {
        input.setCustomValidity('Enter an interval of at least ' + controls.outboundIntervalMinimum() + ' seconds.');
        return null;
      }
      input.setCustomValidity(seconds === null ? 'Enter whole seconds between ' + state.min + ' and ' + state.max + '.' : '');
      return seconds;
    },
    display(input: EditorControl, seconds: number, unit: DurationUnit = 'seconds') {
      const state = durations.get(input)!;
      state.unit = unit; state.seconds = seconds;
      state.control.value = unit;
      input.min = String(state.min / durationFactors[unit]);
      input.max = String(state.max / durationFactors[unit]);
      input.value = String(seconds / durationFactors[unit]);
      state.display = input.value;
      input.setCustomValidity('');
    },
    updateIntervalBounds() {
      const input = controls.get('intervalSeconds');
      const state = durations.get(input)!;
      const minimum = controls.outboundIntervalMinimum();
      input.min = String(Math.min(minimum, savedInterval ?? minimum) / durationFactors[state.unit]);
      if (!input.disabled) duration.validate(input);
    },
  };
  const monitorEditor = {
    get id() { return editingId; },
    open(monitor: EditableMonitor | null = null, hosted = false) {
      editingId = monitor?.id || null;
      selectionChanges.clear();
      form.reset();
      monitorEditor.refreshDestinations(destinations, monitor?.destinationIds ?? []);
      controls.get('monitor-settings').textContent = monitor ? 'Edit Monitor' : 'New Monitor';
      controls.get('name').value = monitor?.name || '';
      controls.get('kind').value = monitor?.kind || 'http';
      controls.get('kind').disabled = editingId !== null;
      controls.get('url').value = monitor?.url || '';
      controls.get('hostname').value = monitor?.hostname || '';
      controls.get('port').value = String(monitor?.port || '');
      controls.get('published').checked = monitor?.published ?? true;
      controls.get('scheduleMode').value = monitor?.scheduleMode || 'interval';
      savedInterval = controls.get('scheduleMode').value === 'interval' ? monitor?.intervalSeconds : undefined;
      newIntervalDefault = controls.outboundIntervalMinimum();
      controls.get('cron').value = monitor?.cron || '0 9 * * *';
      controls.get('timezone').value = monitor?.timezone || 'UTC';
      savedCalendar = monitor?.kind !== 'heartbeat' && monitor?.scheduleMode === 'calendar'
        ? { cron: controls.get('cron').value, timezone: controls.get('timezone').value } : undefined;
      scheduleSuspended = monitor?.scheduleSuspended === true;
      controls.get('cron').setCustomValidity('');
      for (const [field, value] of Object.entries(timingDefaults) as [TimingField, number][]) {
        const input = controls.get(field);
        if (field === 'intervalSeconds') duration.display(input, savedInterval ?? Math.max(monitor?.intervalSeconds ?? value, newIntervalDefault));
        else if (durations.has(input)) duration.display(input, monitor?.[field] ?? value);
        else input.value = String(monitor?.[field] ?? value);
      }
      controls.get('heartbeat-path').textContent = monitor?.kind === 'heartbeat' ? (hosted ? 'POST /heartbeat' : 'POST /heartbeat/' + monitor.id) : '';
      controls.get('rotate-heartbeat').hidden = !hosted || monitor?.kind !== 'heartbeat';
      controls.get('heartbeat-credential').textContent = '';
      (monitor ? controls.get('history-' + monitor.id) : controls.get('new-monitor-panel')).append(form);
      form.hidden = false; monitorEditor.update(); controls.preview();
      controls.get('name').focus();
    },
    setSchedulePolicy(seconds: number, suspended: boolean) {
      const changed = minimumCheckInterval !== seconds || scheduleSuspended !== suspended;
      minimumCheckInterval = seconds;
      scheduleSuspended = suspended;
      if (form.hidden) return;
      duration.updateIntervalBounds();
      if (changed && controls.get('scheduleMode').value === 'calendar' && controls.get('kind').value !== 'heartbeat') controls.preview();
    },
    close() {
      session.cancelPreview(); controls.get('cron').setCustomValidity('');
      const id = editingId;
      controls.get('heartbeat-credential').textContent = '';
      editingId = null; selectionChanges.clear(); savedSelections.clear(); monitorEditor.refreshDestinations(destinations);
      form.reset(); form.hidden = true;
      controls.get('new-monitor-panel').append(form); focusActions(id);
    },
    refreshDestinations(next: NotificationDestination[], selected?: string[]) {
      destinations = next;
      if (selected) savedSelections = new Set(selected);
      const fieldset = controls.get('destination-selection');
      const choices = controls.get('destination-choices');
      const available = editingId ? destinations.filter(destination => destination.channel === 'webhook' || destination.confirmed) : [];
      const availableIds = new Set(available.map(destination => destination.id));
      for (const id of selectionChanges.keys()) if (!availableIds.has(id)) selectionChanges.delete(id);
      const focused = document.activeElement;
      reconcileNodes(choices, available.map(destination => {
        const label = document.createElement('label');
        label.className = 'checkbox';
        label.setAttribute('data-key', destination.id);
        const input = document.createElement('input');
        input.type = 'checkbox'; input.name = 'destinationId'; input.value = destination.id;
        const address = document.createElement('span'); address.textContent = destination.channel === 'email' ? destination.address : destination.url;
        label.append(input, address);
        return label;
      }));
      for (const input of form.querySelectorAll('[name="destinationId"]')) {
        input.checked = selectionChanges.get(input.value) ?? savedSelections.has(input.value);
      }
      fieldset.hidden = editingId === null;
      controls.get('no-destination-choices').hidden = available.length !== 0;
      if (focused?.name === 'destinationId') {
        if (availableIds.has(focused.value)) focused.focus();
        else if (!fieldset.hidden) fieldset.querySelector('legend')?.focus();
      }
    },
    update(ids = monitorIds) {
      monitorIds = ids;

      const kind = controls.get('kind').value;
      const heartbeat = kind === 'heartbeat';
      const calendar = controls.get('scheduleMode').value === 'calendar';
      controls.get('calendar-schedule').hidden = !calendar;
      controls.get('calendar-schedule').disabled = !calendar;
      for (const field of ['cron', 'timezone']) controls.get(field).disabled = !calendar;
      controls.get('intervalSeconds').closest('.duration')!.hidden = calendar;
      controls.get('intervalSeconds').disabled = calendar;
      controls.get('intervalSeconds-unit').disabled = calendar;
      const interval = controls.get('intervalSeconds');
      const minimum = controls.outboundIntervalMinimum();
      if (!editingId && minimum !== newIntervalDefault && duration.seconds(interval) === newIntervalDefault)
        duration.display(interval, minimum, durations.get(interval)!.unit);
      newIntervalDefault = minimum;
      duration.updateIntervalBounds();
      for (const target of ['http', 'tcp']) {
        controls.get(target + '-target').hidden = kind !== target;
        controls.get(target + '-target').disabled = kind !== target;
      }
      controls.get('kind').disabled = !!editingId;
      const active = controls.fields();
      for (const field of Object.keys(timingDefaults) as TimingField[]) {
        if (field === 'intervalSeconds' || field === 'recoveryThreshold') continue;
        const input = controls.get(field);
        const hidden = !active.includes(field);
        input.disabled = hidden; input.hidden = hidden;
        if (durations.has(input)) {
          input.closest('.duration')!.hidden = hidden;
          durations.get(input)!.control.disabled = hidden;
        }
        document.querySelector('label[for="' + field + '"]')!.hidden = hidden;
      }
      document.querySelector('label[for="intervalSeconds"]')!.textContent = heartbeat ? 'Expectation' : 'Interval';
      controls.get('intervalSeconds-unit').setAttribute('aria-label', heartbeat ? 'Expectation unit' : 'Interval unit');
      document.querySelector('label[for="recoveryThreshold"]')!.textContent = heartbeat ? calendar ? 'Consecutive successful occurrences' : 'Recovery receipts' : 'Consecutive successes';

      const missing = editingId !== null && !monitorIds.has(editingId);
      controls.get('monitor-deleted').hidden = !missing;
      controls.get('save-monitor').disabled = missing;
      controls.get('resume-schedule').disabled = missing;
    },
    previewed(data: SchedulePreview) {
      controls.get('resume-schedule').hidden = !scheduleSuspended || !controls.calendarUnchanged();
      controls.get('schedule-explanation').textContent = data.explanation;
      const format = new Intl.DateTimeFormat(undefined, { timeZone: data.timezone, dateStyle: 'medium', timeStyle: 'long' });
      controls.get('schedule-occurrences').replaceChildren(...data.occurrences.map(at => {
        const item = document.createElement('li');
        const time = document.createElement('time');
        time.dataset.schedulePreview = '';
        time.dateTime = new Date(at).toISOString();
        time.textContent = format.format(at) + ' (' + data.timezone + ')';
        item.append(time); return item;
      }));
    },
    previewFailed(error: string) {
      controls.get('schedule-explanation').textContent = error;
      if (!controls.calendarUnchanged()) controls.get('cron').setCustomValidity(error);
    },
  };
  for (const input of form.querySelectorAll('[data-duration]')) {
    const control = controls.get(input.id + '-unit');
    durations.set(input, { control, min: Number(input.min), max: Number(input.max), unit: 'seconds', seconds: Number(input.value), display: input.value });
    duration.display(input, Number(input.value));
    input.addEventListener('input', () => duration.validate(input));
    control.addEventListener('change', () => {
      const seconds = duration.validate(input);
      if (seconds === null) { control.value = durations.get(input)!.unit; input.reportValidity(); return; }
      duration.display(input, seconds, control.value as DurationUnit);
      if (input.id === 'intervalSeconds') duration.updateIntervalBounds();
    });
  }
  for (const field of ['cron', 'timezone', 'graceSeconds']) controls.get(field).addEventListener('input', controls.preview);
  controls.get('graceSeconds-unit').addEventListener('change', controls.preview);
  for (const field of ['scheduleMode', 'kind']) controls.get(field).addEventListener('change', () => { monitorEditor.update(); controls.preview(); });
  form.addEventListener('change', event => {
    const input = event.target as unknown as EditorControl;
    if (input.name !== 'destinationId') return;
    if (input.checked === savedSelections.has(input.value)) selectionChanges.delete(input.value);
    else selectionChanges.set(input.value, input.checked);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (editingId && !monitorIds.has(editingId)) return;
    const body: Record<string, string | number | boolean | null | Record<string, boolean>> = { name: controls.get('name').value, kind: controls.get('kind').value, published: controls.get('published').checked };
    if (body.kind === 'tcp') { body.hostname = controls.get('hostname').value; body.port = Number(controls.get('port').value); }
    else if (body.kind === 'http') body.url = controls.get('url').value;
    const resume = (event as Event & { submitter?: EditorControl }).submitter?.id === 'resume-schedule';
    if (resume || !controls.calendarUnchanged()) {
      body.scheduleMode = controls.get('scheduleMode').value;
      if (body.scheduleMode === 'calendar') { body.cron = controls.get('cron').value; body.timezone = controls.get('timezone').value; }
    }
    for (const field of controls.fields()) {
      const input = controls.get(field);
      body[field] = durations.has(input) ? duration.validate(input) : Number(input.value);
      if (body[field] === null) { input.reportValidity(); return; }
    }
    if (savedInterval !== undefined && body.intervalSeconds === savedInterval && savedInterval < controls.outboundIntervalMinimum())
      delete body.intervalSeconds;
    if (selectionChanges.size) body.destinationChanges = Object.fromEntries(selectionChanges);
    await session.run('/api/operator/monitors' + (editingId ? '/' + encodeURIComponent(editingId) : ''), editingId ? 'PATCH' : 'POST', body, monitorEditor.close);
  });
  controls.get('cancel-edit').addEventListener('click', monitorEditor.close);
  controls.get('rotate-heartbeat').addEventListener('click', () => {
    if (document.defaultView!.confirm('Replace this Monitor’s heartbeat secret?')) session.run('/api/operator/monitors/' + encodeURIComponent(editingId!) + '/heartbeat-secret', 'POST');
  });
  monitorEditor.update();
  return monitorEditor;
}
