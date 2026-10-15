'use strict';
let calendarConfirmationTimer = null;
function calendarConfirmation(message) {
  clearTimeout(calendarConfirmationTimer);
  $('calendar-confirmation').textContent = message;
  show('calendar-confirmation', true);
  calendarConfirmationTimer = setTimeout(() => {
    show('calendar-confirmation', false);
    $('calendar-confirmation').textContent = '';
  }, 4000);
}
let communityCalendar = null,
  calendarLibraries = null,
  calendarRequest = 0,
  calendarReady = false,
  calendarEditing = null;
const calendarLibrariesUrls = [
  'https://cdn.jsdelivr.net/npm/luxon@3.7.2/build/global/luxon.min.js',
  'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.19/index.global.min.js',
  'https://cdn.jsdelivr.net/npm/@fullcalendar/luxon3@6.1.19/index.global.min.js',
];
function calendarZone() {
  return neighborhood?.time_zone || 'America/Chicago';
}
function calendarDate(value, zone = calendarZone()) {
  return window.luxon.DateTime.fromISO(value, { zone });
}
function mayManageEvent(event) {
  return (
    !!membership &&
    event.neighborhood_id === neighborhood?.id &&
    (event.created_by === user?.id || membership.role === 'admin')
  );
}
async function ensureCalendarLibraries() {
  if (!calendarLibraries)
    calendarLibraries = (async () => {
      for (const url of calendarLibrariesUrls) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = url;
          script.onload = resolve;
          script.onerror = () => {
            script.remove();
            reject(Error('The calendar could not load. Please try again.'));
          };
          document.head.append(script);
        });
      }
    })().catch((error) => {
      calendarLibraries = null;
      throw error;
    });
  await calendarLibraries;
}
function resetCommunityCalendar() {
  ++overviewEventsRequest;
  $('overview-events').replaceChildren();
  clearTimeout(calendarConfirmationTimer);
  show('calendar-confirmation', false);
  $('calendar-confirmation').textContent = '';
  ++calendarRequest;
  calendarReady = false;
  calendarEditing = null;
  communityCalendar?.destroy();
  communityCalendar = null;
  $('community-calendar').replaceChildren();
  $('event-detail-content').replaceChildren();
  $('event-detail-actions').replaceChildren();
  $('event-detail-error').textContent = '';
  $('event-form-error').textContent = '';
  [...$('event-form').elements].forEach((el) => {
    if (el.name) el.value = '';
  });
  ['event-detail-dialog', 'event-editor-dialog'].forEach((id) => {
    if ($(id).open) $(id).close();
  });
}
function eventCalendarItem(row) {
  return {
    id: row.id,
    title: `${row.status === 'cancelled' ? 'Cancelled · ' : ''}${row.title}`,
    allDay: row.all_day,
    start: row.all_day ? row.start_date : row.starts_at,
    end: row.all_day ? row.end_date : row.ends_at,
    classNames: row.status === 'cancelled' ? ['event-cancelled'] : [],
    extendedProps: { row },
  };
}
async function fetchCalendarEvents(info, success, failure) {
  const version = generation,
    neighborhoodId = neighborhood?.id,
    request = ++calendarRequest;
  if (!membership || !user) {
    success([]);
    return;
  }
  $('calendar-status').textContent = 'Finding what’s happening nearby…';
  show('calendar-retry', false);
  try {
    const rows = checked(
      await db.rpc('list_neighborhood_events', {
        neighborhood: neighborhoodId,
        range_start: info.startStr,
        range_end: info.endStr,
        first_day: info.startStr.slice(0, 10),
        exclusive_last_day: info.endStr.slice(0, 10),
      }),
    );
    if (
      version !== generation ||
      request !== calendarRequest ||
      neighborhoodId !== neighborhood?.id ||
      !user
    ) {
      success([]);
      return;
    }
    calendarReady = true;
    $('add-event').disabled = false;
    $('calendar-status').textContent = rows.length
      ? `${rows.length} community ${rows.length === 1 ? 'event' : 'events'} in this view`
      : 'Nothing planned here yet. Be the first to bring neighbors together.';
    success(rows.map(eventCalendarItem));
  } catch (error) {
    if (version !== generation || request !== calendarRequest) {
      success([]);
      return;
    }
    calendarReady = false;
    $('add-event').disabled = true;
    $('calendar-status').textContent = ['PGRST202', '42883', '42P01', 'PGRST205'].includes(
      error.code,
    )
      ? 'The community calendar is being set up. Please check back soon.'
      : 'We couldn’t load the events. Please try again.';
    show('calendar-retry', true);
    success([]);
  }
}
async function openCommunityCalendar() {
  if (!membership || !user) return;
  const version = generation;
  $('add-event').disabled = !calendarReady;
  $('calendar-zone').textContent = `All event times · ${calendarZone().replaceAll('_', ' ')}`;
  $('calendar-status').textContent = 'Opening your community calendar…';
  try {
    await ensureCalendarLibraries();
  } catch (error) {
    if (version === generation) {
      $('calendar-status').textContent = error.message;
      show('calendar-retry', true);
    }
    return;
  }
  if (version !== generation || !membership || $('calendar').hidden) return;
  if (communityCalendar) {
    communityCalendar.updateSize();
    communityCalendar.refetchEvents();
    return;
  }
  const upcoming = window.matchMedia('(max-width: 700px)').matches;
  communityCalendar = new window.FullCalendar.Calendar($('community-calendar'), {
    initialView: upcoming ? 'listNext90' : 'dayGridMonth',
    initialDate: window.luxon.DateTime.now().setZone(calendarZone()).toISODate(),
    timeZone: calendarZone(),
    views: { listNext90: { type: 'list', duration: { days: 90 }, buttonText: 'Upcoming' } },
    headerToolbar: { left: 'prev,next today', center: 'title', right: '' },
    buttonText: { today: 'Today' },
    height: 'auto',
    fixedWeekCount: false,
    dayMaxEvents: 3,
    editable: false,
    eventDisplay: 'block',
    eventTimeFormat: { hour: 'numeric', minute: '2-digit', meridiem: 'short' },
    noEventsContent: 'No events in this period. Make a plan with your neighbors.',
    events: fetchCalendarEvents,
    dateClick: (info) => openEventEditor(null, info.dateStr.slice(0, 10)),
    eventClick: (info) => {
      info.jsEvent?.preventDefault();
      run(() => openEventDetail(info.event.id));
    },
    eventDidMount: (info) => {
      const row = info.event.extendedProps.row;
      info.el.title = `${info.event.title} — ${eventWhen(row)}`;
      info.el.setAttribute('aria-label', info.el.title);
    },
    eventContent: (info) => {
      const span = document.createElement('span');
      const row = info.event.extendedProps.row;
      span.className = 'calendar-event-label';
      span.textContent = `${info.timeText ? `${info.timeText} · ` : ''}${info.event.title}`;
      span.title = `${info.event.title} — ${eventWhen(row)}`;
      return { domNodes: [span] };
    },
  });
  communityCalendar.render();
  syncCalendarSwitch(upcoming);
}
function syncCalendarSwitch(upcoming) {
  $('calendar-month').setAttribute('aria-pressed', String(!upcoming));
  $('calendar-upcoming').setAttribute('aria-pressed', String(upcoming));
}
function eventWhen(event) {
  if (event.all_day) {
    const first = calendarDate(event.start_date, event.time_zone);
    const last = calendarDate(event.end_date, event.time_zone).minus({ days: 1 });
    return `${first.toLocaleString(window.luxon.DateTime.DATE_FULL)}${first.toISODate() === last.toISODate() ? '' : ` – ${last.toLocaleString(window.luxon.DateTime.DATE_FULL)}`} · All day`;
  }
  const start = calendarDate(event.starts_at, event.time_zone),
    end = calendarDate(event.ends_at, event.time_zone);
  return `${start.toFormat('ccc, LLL d, yyyy · h:mm a')} – ${end.toFormat(start.toISODate() === end.toISODate() ? 'h:mm a' : 'ccc, LLL d, yyyy · h:mm a')} (${start.offsetNameShort}${start.offset !== end.offset ? ` → ${end.offsetNameShort}` : ''})`;
}
async function openEventDetail(id) {
  if (!membership) return;
  const version = generation;
  const row = checked(
    await db
      .from('neighborhood_events')
      .select('*')
      .eq('id', id)
      .eq('neighborhood_id', neighborhood.id)
      .maybeSingle(),
  );
  if (version !== generation || !user || $('calendar').hidden) return;
  if (!row) throw Error('This event is no longer available. Refresh the calendar.');
  $('event-detail-error').textContent = '';
  $('event-detail-content').innerHTML =
    `${row.status === 'cancelled' ? '<span class="event-status-cancelled">Cancelled</span>' : ''}<h2 id="event-detail-title">${esc(row.title)}</h2><p class="event-when">${esc(eventWhen(row))}</p>${row.location ? `<p class="event-location"><strong>Where</strong><br>${esc(row.location)}</p>` : ''}<p class="event-description">${esc(row.description || 'Come spend some time with your neighbors.')}</p><p class="calendar-footnote">Organized by ${esc(row.organizer_name)}</p>`;
  $('event-detail-actions').replaceChildren();
  const button = (text, action, className = '') => {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = className;
    b.onclick = () => run(action);
    $('event-detail-actions').append(b);
    return b;
  };
  button(
    row.status === 'cancelled' ? 'Download cancellation (.ics)' : 'Add to my calendar (.ics)',
    () => downloadEventCalendar(row),
  );
  if (mayManageEvent(row)) {
    button('Edit event', () => {
      $('event-detail-dialog').close();
      openEventEditor(row);
    });
    if (row.status !== 'cancelled') {
      const cancel = button(
        'Cancel event',
        async () => {
          if (!confirm(`Cancel “${row.title}”? It will stay on the calendar marked cancelled.`))
            return;
          cancel.disabled = true;
          try {
            checked(
              await db.rpc('cancel_neighborhood_event', {
                event_id: row.id,
                expected_revision: row.revision,
              }),
            );
            if (version !== generation) return;
            $('event-detail-dialog').close();
            communityCalendar?.refetchEvents();
            calendarConfirmation('Event cancelled.');
          } catch (error) {
            $('event-detail-error').textContent = error.message || 'Unable to cancel this event.';
          } finally {
            cancel.disabled = false;
          }
        },
        'danger',
      );
    }
  }
  $('event-detail-dialog').showModal();
}
function syncEventDateFields() {
  const allDay = $('event-form').elements.all_day.checked;
  show('event-day-fields', allDay);
  show('event-timed-fields', !allDay);
  for (const name of ['starts', 'ends']) {
    $('event-form').elements[name].disabled = allDay;
    $('event-form').elements[name].required = !allDay;
  }
  for (const name of ['first_day', 'last_day']) {
    $('event-form').elements[name].disabled = !allDay;
    $('event-form').elements[name].required = allDay;
  }
}
function openEventEditor(row = null, day = null) {
  if (!membership || !calendarReady || (row && !mayManageEvent(row))) return;
  calendarEditing = row;
  const form = $('event-form'),
    zone = calendarZone();
  const date = calendarDate(day || window.luxon.DateTime.now().setZone(zone).toISODate());
  const start = row && !row.all_day ? calendarDate(row.starts_at, zone) : date.set({ hour: 18 });
  const end = row && !row.all_day ? calendarDate(row.ends_at, zone) : start.plus({ hours: 1 });
  form.elements.title.value = row?.title || '';
  form.elements.description.value = row?.description || '';
  form.elements.location.value = row?.location || '';
  form.elements.all_day.checked = row?.all_day || false;
  form.elements.starts.value = start.toFormat("yyyy-MM-dd'T'HH:mm");
  form.elements.ends.value = end.toFormat("yyyy-MM-dd'T'HH:mm");
  form.elements.first_day.value = row?.all_day ? row.start_date : start.toISODate();
  form.elements.last_day.value = row?.all_day
    ? calendarDate(row.end_date).minus({ days: 1 }).toISODate()
    : end.toISODate();
  $('event-editor-title').textContent = row
    ? 'Edit your community event'
    : 'What’s happening in the neighborhood?';
  $('event-editor-zone').textContent = `Dates and times are in ${zone.replaceAll('_', ' ')}.`;
  $('event-save').textContent = row ? 'Save changes' : 'Publish event';
  $('event-save').disabled = false;
  $('event-form-error').textContent =
    row?.status === 'cancelled'
      ? 'This event is cancelled. Saving changes will keep it cancelled.'
      : '';
  syncEventDateFields();
  $('event-editor-dialog').showModal();
}
function eventTimeToUtc(value, zone = calendarZone()) {
  const parsed = calendarDate(value, zone);
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== value)
    throw Error('That local time does not exist because of a clock change. Choose another time.');
  if (parsed.getPossibleOffsets().length > 1)
    throw Error(
      'That time occurs twice when the clocks change. Choose a time outside the repeated hour.',
    );
  return parsed.toUTC().toISO();
}
function eventSaveArguments(form) {
  const allDay = form.elements.all_day.checked;
  if (!form.elements.title.value.trim()) throw Error('Give your event a title.');
  const first = form.elements.first_day.value,
    last = form.elements.last_day.value;
  let starts = null,
    ends = null,
    exclusive = null;
  if (allDay) {
    const a = calendarDate(first),
      b = calendarDate(last);
    if (!a.isValid || !b.isValid || b < a || b.diff(a, 'days').days >= 366)
      throw Error(
        'Choose valid event dates, with the last day on or after the first (up to 366 days).',
      );
    exclusive = b.plus({ days: 1 }).toISODate();
  } else {
    starts = eventTimeToUtc(form.elements.starts.value);
    ends = eventTimeToUtc(form.elements.ends.value);
    const length = Date.parse(ends) - Date.parse(starts);
    if (length <= 0 || length > 366 * 86400000)
      throw Error('The end must be after the start, within 366 days.');
  }
  return {
    neighborhood: neighborhood.id,
    event_id: calendarEditing?.id || null,
    expected_revision: calendarEditing?.revision || null,
    event_title: form.elements.title.value.trim(),
    event_description: form.elements.description.value,
    event_location: form.elements.location.value.trim(),
    is_all_day: allDay,
    start_time: starts,
    end_time: ends,
    first_day: allDay ? first : null,
    exclusive_last_day: exclusive,
  };
}
function escapeCalendarText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}
function foldCalendarLine(line) {
  const lines = [];
  let current = '',
    size = 0;
  for (const char of line) {
    const bytes = new TextEncoder().encode(char).length;
    if (size + bytes > 75) {
      lines.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += bytes;
  }
  lines.push(current);
  return lines.join('\r\n');
}
function eventIcs(event) {
  const utc = (iso) =>
    new Date(iso)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  const date = (value) => value.replaceAll('-', '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Neighborhood Connect//Community Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.id}@neighborhood-connect`,
    `DTSTAMP:${utc(event.updated_at)}`,
    `SEQUENCE:${event.revision}`,
    event.all_day
      ? `DTSTART;VALUE=DATE:${date(event.start_date)}`
      : `DTSTART:${utc(event.starts_at)}`,
    event.all_day ? `DTEND;VALUE=DATE:${date(event.end_date)}` : `DTEND:${utc(event.ends_at)}`,
    `SUMMARY:${escapeCalendarText(event.title)}`,
    `DESCRIPTION:${escapeCalendarText(event.description)}`,
    `LOCATION:${escapeCalendarText(event.location)}`,
    `STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldCalendarLine).join('\r\n') + '\r\n';
}
function downloadEventCalendar(row) {
  const url = URL.createObjectURL(
    new Blob([eventIcs(row)], { type: 'text/calendar;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `neighborhood-event-${row.id}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function closeEventEditor() {
  // Publishing is already in progress; closing cannot undo a submitted event.
  if ($('event-save').disabled) return;
  $('event-editor-dialog').close();
  calendarEditing = null;
  [...$('event-form').elements].forEach((el) => {
    if (el.name) el.value = '';
    if (el.type === 'checkbox') el.checked = false;
  });
  $('event-form-error').textContent = '';
  $('add-event').focus();
}
function initCommunityCalendar() {
  $('overview-open-calendar').onclick = () => view('calendar');
  $('add-event').onclick = () => openEventEditor();
  $('calendar-month').onclick = () => {
    communityCalendar?.changeView('dayGridMonth');
    syncCalendarSwitch(false);
  };
  $('calendar-upcoming').onclick = () => {
    if (!communityCalendar) return;
    communityCalendar?.changeView(
      'listNext90',
      window.luxon.DateTime.now().setZone(calendarZone()).toISODate(),
    );
    syncCalendarSwitch(true);
  };
  $('calendar-retry').onclick = () => run(openCommunityCalendar);
  $('event-detail-close').onclick = () => $('event-detail-dialog').close();
  $('event-editor-close').onclick = closeEventEditor;
  $('event-editor-cancel').onclick = closeEventEditor;
  $('event-editor-dialog').oncancel = (event) => {
    event.preventDefault();
    closeEventEditor();
  };
  $('event-editor-dialog').onclick = (event) => {
    if (event.target !== $('event-editor-dialog')) return;
    const bounds = event.target.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      closeEventEditor();
  };
  $('event-form').elements.all_day.onchange = () => {
    const form = $('event-form');
    if (form.elements.all_day.checked) {
      form.elements.first_day.value = form.elements.starts.value.slice(0, 10);
      form.elements.last_day.value = form.elements.ends.value.slice(0, 10);
    } else {
      form.elements.starts.value = `${form.elements.first_day.value}T${form.elements.starts.value.slice(11) || '18:00'}`;
      form.elements.ends.value = `${form.elements.last_day.value}T${form.elements.ends.value.slice(11) || '19:00'}`;
    }
    syncEventDateFields();
  };
  $('event-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target,
      button = $('event-save'),
      version = generation;
    if (button.disabled || !membership || !form.reportValidity()) return;
    button.disabled = true;
    $('event-form-error').textContent = '';
    try {
      checked(await db.rpc('save_neighborhood_event', eventSaveArguments(form)));
      if (version !== generation) return;
      $('event-editor-dialog').close();
      communityCalendar?.refetchEvents();
      calendarConfirmation(calendarEditing ? 'Event updated.' : 'Event added to the calendar.');
    } catch (error) {
      if (version === generation)
        $('event-form-error').textContent = error.message || 'Unable to save this event.';
    } finally {
      button.disabled = false;
    }
  };
}

let overviewEventsRequest = 0;
async function loadOverviewEvents() {
  if (!membership || !user) return;
  const version = generation,
    neighborhoodId = neighborhood.id,
    request = ++overviewEventsRequest,
    host = $('overview-events'),
    now = new Date(),
    until = new Date(now.getTime() + 90 * 86400000),
    zone = calendarZone();
  const localDay = (date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (name) => parts.find((p) => p.type === name).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const current = () =>
    version === generation &&
    request === overviewEventsRequest &&
    !!user &&
    !!membership &&
    neighborhood?.id === neighborhoodId;
  host.innerHTML = '<p class="overview-events-empty">Loading upcoming events…</p>';
  try {
    const rows = checked(
      await db.rpc('list_neighborhood_events', {
        neighborhood: neighborhoodId,
        range_start: now.toISOString(),
        range_end: until.toISOString(),
        first_day: localDay(now),
        exclusive_last_day: localDay(new Date(until.getTime() + 86400000)),
      }),
    );
    if (!current()) return;
    const events = rows
      .filter(
        (row) =>
          row.status !== 'cancelled' &&
          (row.all_day ? row.end_date > localDay(now) : new Date(row.ends_at) > now),
      )
      .sort((a, b) => {
        const stamp = (row) => (row.all_day ? row.start_date : localDay(new Date(row.starts_at)));
        return (
          stamp(a).localeCompare(stamp(b)) ||
          String(a.starts_at || '').localeCompare(String(b.starts_at || ''))
        );
      })
      .slice(0, 3);
    host.replaceChildren();
    if (!events.length) {
      host.innerHTML =
        '<p class="overview-events-empty">No upcoming events in the next 90 days. Make a plan with your neighbors.</p>';
      return;
    }
    for (const row of events) {
      const date = new Date(row.all_day ? row.start_date + 'T12:00:00Z' : row.starts_at);
      const timeZone = row.all_day ? 'UTC' : zone;
      const button = document.createElement('button');
      button.className = 'overview-event';
      const badge = document.createElement('span');
      badge.className = 'overview-event-date';
      badge.textContent = new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
      }).format(date);
      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = row.title;
      const when = document.createElement('small');
      when.textContent = row.all_day
        ? 'All day'
        : new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hour: 'numeric',
            minute: '2-digit',
          }).format(date);
      if (row.location) when.textContent += ' · ' + row.location;
      text.append(title, when);
      button.append(badge, text);
      button.onclick = () =>
        run(async () => {
          view('calendar');
          await ensureCalendarLibraries();
          if (current()) await openEventDetail(row.id);
        });
      host.append(button);
    }
  } catch {
    if (current())
      host.innerHTML =
        '<p class="overview-events-empty">Upcoming events are unavailable right now. Open the calendar to try again.</p>';
  }
}
