// SPDX-License-Identifier: AGPL-3.0-only
import type { AvailabilityHistory, Status } from './index';

// Self-contained: the same implementation runs in the Worker and the classic browser script.
export function createStatusLedger() {
  const stateLabel = {
    unknown: 'Awaiting check', up: 'Operational', down: 'Unavailable',
    maintenance: 'Maintenance', paused: 'Monitoring paused',
  };
  const markup = {
    escape(value: string) {
      return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    },
    timestamp(at: number, crossDay: boolean) {
      const value = new Date(at).toISOString();
      return '<time data-incident-time="' + (crossDay ? 'full' : 'compact') + '" datetime="' + value + '">' + value + '</time>';
    },
    banner(status: Status) {
      return status.paused ? 'Monitoring paused' : !status.monitors.length
        ? 'No Monitors published'
        : status.incidents.some(incident => incident.closedAt === null) || status.monitors.some(monitor => monitor.state === 'down')
          ? 'Services unavailable'
          : status.monitors.every(monitor => monitor.state === 'maintenance')
            ? 'Maintenance'
          : status.monitors.every(monitor => monitor.state === 'up' || monitor.state === 'maintenance') && status.monitors.some(monitor => monitor.state === 'maintenance')
            ? 'Some services in Maintenance'
          : status.monitors.every(monitor => monitor.state === 'up')
            ? 'All services operational'
            : 'Awaiting check';
    },
  };
  const ledger = {
    stateLabel,
    history(history: AvailabilityHistory | null | undefined, id: string) {
      if (!history) return '<p class="history-unavailable">Bars unavailable</p>';
      return '<div class="availability"><div class="history-head"><span>past 90 days</span><span class="percentage" aria-label="Availability">' +
        (history.percentage === null ? 'No observations' : history.percentage.toFixed(2) + '%') +
        '</span></div>' + (history.stale ? '<p class="history-unavailable" role="status">Availability history is stale</p>' : '') + '<ol class="history" data-monitor="' + encodeURIComponent(id) + '" aria-label="90 UTC days of availability">' +
        history.days.map((day, index) => {
          const label = ({ empty: 'No observations', up: 'Successful checks', down: 'Failed checks', degraded: 'Mixed results', maintenance: 'Maintenance' })[day.state] +
            '; ' + day.successes + ' successes, ' + day.failures + ' failures, ' + day.maintenance + ' Maintenance';
          return '<li class="history-day ' + markup.escape(day.state) + '" data-date="' + markup.escape(day.date) + '" data-detail="' + markup.escape(label) +
            '" data-successes="' + day.successes + '" data-failures="' + day.failures + '" data-maintenance="' + day.maintenance + '" tabindex="' + (index === history.days.length - 1 ? 0 : -1) + '" aria-label="' + markup.escape(day.date + ' UTC: ' + label) + '"></li>';
        }).join('') + '</ol><div class="history-detail"><span class="history-counts" role="status" aria-live="polite" aria-atomic="true"></span><details><summary>Exact time range</summary><p class="utc-range"></p><p class="local-range"></p></details></div></div>';
    },
    incidents(status: Pick<Status, "monitors" | "incidents">, operator = false) {
      if (!status.incidents.length) return '<p>No Incidents</p>';
      return [true, false].map(ongoing => {
        const records = status.incidents.filter(incident => (incident.closedAt === null) === ongoing);
        if (!records.length) return '';
        const label = ongoing ? 'Ongoing' : 'Resolved';
        return '<section aria-label="' + label + '"><h3>' + label + '</h3><ul class="incidents">' + records.map(incident => {
          const monitor = status.monitors.find(monitor => monitor.id === incident.monitorId);
          const crossDay = new Date(incident.openedAt).toISOString().slice(0, 10) !== new Date(incident.closedAt ?? Date.now()).toISOString().slice(0, 10);
          return '<li data-key="' + encodeURIComponent(incident.monitorId) + ':' + incident.openedAt + '"><article class="incident"><div class="incident-top"><h4>' + markup.escape(monitor?.name ?? incident.monitorName ?? incident.monitorId) + '</h4>' + (operator && !monitor ? '<span class="deleted">Deleted Monitor</span>' : '') + '<span class="incident-state" data-state="' + (ongoing ? 'down' : 'up') + '">' + (ongoing ? 'Ongoing' : 'Recovered') + '</span></div><div class="incident-facts"><span>Started ' + markup.timestamp(incident.openedAt, crossDay) + '</span>' + (incident.closedAt === null ? '' : '<span>Recovered ' + markup.timestamp(incident.closedAt, crossDay) + '</span>') + '<span class="incident-duration" data-start="' + incident.openedAt + '"' + (incident.closedAt === null ? '' : ' data-end="' + incident.closedAt + '"') + ' aria-label="Elapsed duration"></span></div></article></li>';
        }).join('') + '</ul></section>';
      }).join('');
    },
    destinationActions(destination: { channel: string; confirmed?: boolean }, emailConfigured: boolean) {
      if (destination.channel !== 'email') return ['Replace', 'Remove'];
      if (!emailConfigured) return ['Remove'];
      return destination.confirmed ? ['Replace', 'Remove'] : ['Resend confirmation', 'Replace', 'Remove'];
    },
    submissionLabel(result: { status: string; reason?: string }) {
      const reasons: Record<string, string> = {
        network: 'Provider connection failed', rate_limited: 'Provider rate limit',
        provider_unavailable: 'Provider unavailable', provider_rejected: 'Provider rejected the submission',
        eligibility_unavailable: 'Eligibility check unavailable', expired: 'Job expired',
        attempts_exhausted: 'Retry limit reached',
      };
      const status = result.status === 'accepted' ? 'Submission accepted'
        : result.status === 'canceled' ? 'Submission canceled'
          : result.status === 'retrying' ? 'Submission failed · Retrying' : 'Submission failed';
      return [status, result.reason && reasons[result.reason]].filter(Boolean).join(' · ');
    },
    banner: markup.banner,
    row(monitor: Status["monitors"][number]) {
      const id = markup.escape(monitor.id);
      return '<article data-key="' + id + '" aria-labelledby="monitor-name-' + id + '"><div class="ledger-row" data-state="' +
        markup.escape(monitor.state) + '"><h2 id="monitor-name-' + id + '">' + markup.escape(monitor.name) +
        '</h2><span class="status">' + stateLabel[monitor.state] + '</span></div>' + ledger.history(monitor.history, monitor.id) + '</article>';
    },
    render(data: Status) {
      const banner = markup.banner(data);
      return '<h1>' + markup.escape(data.pageName) + '</h1><section class="banner" data-state="' +
        (banner === 'All services operational' ? 'up' : banner === 'Services unavailable' ? 'down' : 'unknown') +
        '" aria-label="Current status"><h2>' + banner + '</h2></section><div class="ledger">' +
        data.monitors.map(ledger.row).join('') + '</div><section id="public-incidents"' + (data.monitors.length ? '' : ' hidden') +
        ' aria-labelledby="incident-heading"><h2 id="incident-heading">Incidents</h2>' + ledger.incidents(data) + '</section>';
    },
  };
  return ledger;
}

export function monitorActions(monitor: { published?: boolean }) {
  return [
    { key: 'edit', label: 'Edit', icon: 'M13 3l4 4-9 9-5 1 1-5z M11 5l4 4' },
    { key: 'publication', label: monitor.published ? 'Unpublish' : 'Publish', icon: monitor.published ? 'M2 2l16 16 M8 4a10 10 0 0 1 10 6 12 12 0 0 1-3 4 M5 5a12 12 0 0 0-3 5 10 10 0 0 0 10 6 M8 8a3 3 0 0 0 4 4' : 'M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z M13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0' },
    { key: 'maintenance', label: 'Maintenance', icon: 'M12 3a5 5 0 0 0-5 6l-5 5a2 2 0 0 0 3 3l5-5a5 5 0 0 0 6-6l-3 3-3-3z' },
    { key: 'delete', label: 'Delete', icon: 'M3 5h14 M7 5V2h6v3 M5 5l1 13h8l1-13 M8 8v7 M12 8v7' },
  ];
}
