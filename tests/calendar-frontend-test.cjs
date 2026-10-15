const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { DateTime } = require('luxon');
const root = require('node:path').resolve(__dirname, '..');
const { window, document } = parseHTML(fs.readFileSync(root + '/index.html', 'utf8'));
Object.defineProperty(window.HTMLElement.prototype, 'elements', {
  get() {
    const els = [...this.querySelectorAll('input,textarea,select,button')];
    for (const el of els) if (el.name) els[el.name] = el;
    return els;
  },
});
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.showModal = () => (dialog.open = true);
  dialog.close = () => (dialog.open = false);
}
for (const form of document.querySelectorAll('form')) form.reportValidity = () => true;
let rows = [
  {
    id: 'event1',
    neighborhood_id: 'n1',
    created_by: 'owner',
    organizer_name: 'A Neighbor',
    title: 'Meet <script>alert(1)</script>',
    description: 'Bring chairs',
    location: 'Park',
    all_day: false,
    starts_at: '2026-11-01T18:00:00-06:00',
    ends_at: '2026-11-01T19:00:00-06:00',
    time_zone: 'America/Chicago',
    status: 'scheduled',
    revision: 1,
    updated_at: '2026-10-15T10:00:00Z',
  },
];
const calls = [];
let fail = false,
  successRows = [];
const info = { startStr: '2026-11-01T00:00:00-05:00', endStr: '2026-12-01T00:00:00-06:00' };
class Calendar {
  constructor(el, opts) {
    this.opts = opts;
    this.el = el;
    Calendar.latest = this;
  }
  render() {
    this.lastFetch = this.opts.events(
      info,
      (r) => (successRows = r),
      () => {},
    );
  }
  refetchEvents() {
    this.render();
  }
  changeView(name, date) {
    this.changed = [name, date];
  }
  updateSize() {}
  destroy() {
    this.destroyed = true;
  }
}
window.matchMedia = () => ({ matches: false });
window.FullCalendar = { Calendar };
window.luxon = { DateTime };
const ctx = vm.createContext({
  window,
  document,
  Date,
  TextEncoder,
  URL,
  Blob,
  setTimeout,
  clearTimeout,
  console,
  user: { id: 'owner' },
  membership: { role: 'resident' },
  neighborhood: { id: 'n1', time_zone: 'America/Chicago' },
  generation: 1,
  $: (id) => document.getElementById(id),
  show: (id, value) => (document.getElementById(id).hidden = !value),
  esc: (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    ),
  checked: (r) => {
    if (r.error) throw r.error;
    return r.data;
  },
  notice: () => {},
  confirm: () => true,
  run: async (fn) => fn(),
  db: {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (fail) return { error: { code: 'PGRST202' } };
      return { data: name === 'list_neighborhood_events' ? rows : 'event1' };
    },
    from: () => ({
      select() {
        return this;
      },
      eq() {
        return this;
      },
      async maybeSingle() {
        return { data: rows[0] };
      },
    }),
  },
});
vm.runInContext(fs.readFileSync(root + '/calendar.js', 'utf8'), ctx);
const exec = (s) => vm.runInContext(s, ctx);
(async () => {
  exec('calendarLibraries=Promise.resolve();initCommunityCalendar();');
  document.getElementById('calendar').hidden = false;
  await exec('openCommunityCalendar()');
  await Calendar.latest.lastFetch;
  assert.equal(Calendar.latest.opts.timeZone, 'America/Chicago');
  assert.equal(Calendar.latest.opts.initialView, 'dayGridMonth');
  assert.equal(successRows.length, 1);
  assert.equal(document.getElementById('add-event').disabled, false);
  document.getElementById('calendar-upcoming').onclick();
  assert.equal(Calendar.latest.changed[0], 'listNext90');
  assert.equal(exec("eventTimeToUtc('2026-07-04T18:00')"), '2026-07-04T23:00:00.000Z');
  assert.equal(exec("eventTimeToUtc('2026-12-04T18:00')"), '2026-12-05T00:00:00.000Z');
  assert.throws(() => exec("eventTimeToUtc('2026-03-08T02:30')"), /does not exist/);
  assert.throws(() => exec("eventTimeToUtc('2026-11-01T01:30')"), /occurs twice/);
  document.getElementById('add-event').focus = () => {};
  const writesBeforeCancel = calls.filter((c) => c.name === 'save_neighborhood_event').length;
  for (const control of ['event-editor-cancel', 'event-editor-close', 'escape', 'backdrop']) {
    exec("openEventEditor(null,'2026-12-24')");
    document.getElementById('event-form').elements.title.value = 'An unsaved draft';
    const dialog = document.getElementById('event-editor-dialog');
    if (control === 'escape') dialog.oncancel({ preventDefault() {} });
    else if (control === 'backdrop') {
      dialog.getBoundingClientRect = () => ({ left: 100, right: 500, top: 100, bottom: 500 });
      dialog.onclick({ target: dialog, clientX: 20, clientY: 20 });
    } else document.getElementById(control).onclick();
    assert.equal(dialog.open, false);
    assert.equal(document.getElementById('event-form').elements.title.value, '');
  }
  assert.equal(
    calls.filter((c) => c.name === 'save_neighborhood_event').length,
    writesBeforeCancel,
  );
  assert.equal(document.getElementById('event-editor-cancel').getAttribute('type'), 'button');
  exec("openEventEditor(null,'2026-12-24')");
  const form = document.getElementById('event-form');
  form.elements.title.value = 'Holiday walk';
  form.elements.all_day.checked = true;
  form.elements.first_day.value = '2026-12-24';
  form.elements.last_day.value = '2026-12-25';
  exec('syncEventDateFields()');
  assert.equal(form.elements.starts.disabled, true);
  const args = exec("eventSaveArguments($('event-form'))");
  assert.equal(args.exclusive_last_day, '2026-12-26');
  assert.equal(args.start_time, null);
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.equal(
    calls.find((c) => c.name === 'save_neighborhood_event').args.event_title,
    'Holiday walk',
  );
  assert.equal(document.getElementById('event-editor-dialog').open, false);
  await exec("openEventDetail('event1')");
  assert.equal(document.getElementById('event-detail-content').querySelector('script'), null);
  assert.equal(document.getElementById('event-detail-title').textContent, rows[0].title);
  assert.ok(document.getElementById('event-detail-actions').textContent.includes('Edit event'));
  ctx.user = { id: 'other' };
  await exec("openEventDetail('event1')");
  assert.equal(
    document.getElementById('event-detail-actions').textContent.includes('Edit event'),
    false,
  );
  ctx.membership = { role: 'admin' };
  await exec("openEventDetail('event1')");
  assert.equal(
    document.getElementById('event-detail-actions').textContent.includes('Edit event'),
    true,
  );
  ctx.icsRow = {
    ...rows[0],
    all_day: true,
    start_date: '2026-12-24',
    end_date: '2026-12-26',
    title: 'Long title ' + '🌳'.repeat(40) + '\r\nInjected: no',
    status: 'cancelled',
  };
  const ics = exec('eventIcs(icsRow)');
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261226'));
  assert.ok(ics.includes('STATUS:CANCELLED'));
  assert.equal(ics.includes('\r\nInjected:'), false);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
  fail = true;
  await Calendar.latest.opts.events(
    info,
    () => {},
    () => {},
  );
  assert.equal(document.getElementById('add-event').disabled, true);
  assert.ok(document.getElementById('calendar-status').textContent.includes('being set up'));
  exec('resetCommunityCalendar()');
  assert.equal(Calendar.latest.destroyed, true);
  assert.equal(document.getElementById('event-detail-content').textContent, '');
  console.log(
    'PASS: calendar views, timezone/DST gaps and overlaps, inclusive editor/exclusive stored all-day dates, publishing, safe detail rendering, owner/admin controls, ICS escaping/folding/cancellation, setup fallback and sign-out cleanup.',
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
