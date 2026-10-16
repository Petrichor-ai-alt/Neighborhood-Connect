const fs = require('node:fs'),
  vm = require('node:vm'),
  assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const root = require('node:path').resolve(__dirname, '..');
const { window, document } = parseHTML(fs.readFileSync(root + '/index.html', 'utf8'));
Object.defineProperty(window.HTMLElement.prototype, 'elements', {
  get() {
    const els = [...this.querySelectorAll('input,textarea,select,button')];
    for (const el of els) if (el.name) els[el.name] = el;
    return els;
  },
});
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
  configurable: true,
  get() {
    return (
      this.querySelector('option[selected]')?.value || this.querySelector('option')?.value || ''
    );
  },
  set(value) {
    this.querySelectorAll('option').forEach((o) =>
      o.value === value ? o.setAttribute('selected', '') : o.removeAttribute('selected'),
    );
  },
});
for (const el of document.querySelectorAll('*')) el.focus = () => {};
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
  };
}
for (const form of document.querySelectorAll('form')) form.reportValidity = () => true;
let threads = [
  {
    id: 't1',
    neighborhood_id: 'n1',
    author_user_id: 'owner',
    author_name: 'Sam <script>',
    title: 'Ideas <img src=x onerror=alert(1)>',
    body: 'Hello <script>alert(1)</script>',
    category: 'ideas',
    status: 'open',
    reply_count: 1,
    revision: 1,
    created_at: '2026-10-15T12:00:00Z',
    last_activity: '2026-10-15T12:00:00Z',
  },
];
let replies = [
  {
    id: 'r1',
    thread_id: 't1',
    author_user_id: 'other',
    author_name: 'Another neighbor',
    body: 'Great <script>idea</script>',
    revision: 1,
    created_at: '2026-10-15T13:00:00Z',
  },
];
let fail = false,
  hold = null;
const calls = [];
const db = {
  from(table) {
    const filters = [];
    let one = false,
      range = [0, 1000];
    return {
      select() {
        return this;
      },
      eq(key, value) {
        filters.push([key, value]);
        return this;
      },
      order() {
        return this;
      },
      range(a, b) {
        range = [a, b];
        return this;
      },
      maybeSingle() {
        one = true;
        return this;
      },
      async then(resolve) {
        if (hold) await hold;
        if (fail) return resolve({ error: { code: '42P01' } });
        const rows = (table === 'discussion_threads' ? threads : replies).filter((r) =>
          filters.every(([k, v]) => r[k] === v),
        );
        return resolve({ data: one ? rows[0] || null : rows.slice(range[0], range[1] + 1) });
      },
    };
  },
  async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'save_discussion_thread') {
      let row = threads.find((t) => t.id === args.thread);
      if (!row) {
        row = { ...threads[0], id: 't2', author_user_id: 'owner', reply_count: 0 };
        threads.push(row);
      }
      Object.assign(row, {
        title: args.thread_title,
        body: args.thread_body,
        category: args.thread_category,
      });
      return { data: row.id };
    }
    if (name === 'save_discussion_reply') return { data: 'r2' };
    if (name === 'moderate_discussion') {
      const row = threads.find((t) => t.id === args.thread);
      if (args.action === 'remove') threads = threads.filter((t) => t.id !== args.thread);
      else {
        row.status = args.action === 'close' ? 'closed' : 'open';
        row.revision++;
      }
    }
    if (name === 'remove_discussion_reply') replies = replies.filter((r) => r.id !== args.reply);
    return { data: null };
  },
};
const ctx = vm.createContext({
  window,
  document,
  db,
  Intl,
  Date,
  setTimeout,
  clearTimeout,
  console,
  user: { id: 'owner' },
  membership: { role: 'resident' },
  neighborhood: { id: 'n1', time_zone: 'America/Chicago' },
  generation: 1,
  $: (id) => document.getElementById(id),
  show: (id, value) => {
    document.getElementById(id).hidden = !value;
  },
  checked: (r) => {
    if (r.error) throw r.error;
    return r.data;
  },
  esc: (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    ),
  confirm: () => true,
  run: async (fn) => fn(),
});
vm.runInContext(fs.readFileSync(root + '/discussions.js', 'utf8'), ctx);
const exec = (code) => vm.runInContext(code, ctx);
const $ = (id) => document.getElementById(id);
(async () => {
  exec('initDiscussions()');
  $('discussions').hidden = false;
  await exec('openDiscussions()');
  assert.equal(document.querySelectorAll('.discussion-row').length, 1);
  assert.equal(document.querySelector('.discussion-row img'), null);
  assert.ok(document.querySelector('.discussion-row strong').textContent.includes('<img'));
  await exec("openDiscussionThread('t1')");
  assert.equal($('discussion-back').hidden, false);
  assert.ok($('discussion-back').textContent.includes('Back to all discussions'));
  await $('discussion-back').onclick();
  assert.equal($('discussion-back').hidden, true);
  assert.equal($('discussion-detail-view').hidden, true);
  assert.equal($('discussion-list-view').hidden, false);
  assert.equal(document.querySelectorAll('.discussion-row').length, 1);
  await exec("openDiscussionThread('t1')");
  assert.equal($('discussion-content').querySelector('script'), null);
  assert.equal($('discussion-replies').querySelector('script'), null);
  assert.ok($('discussion-actions').textContent.includes('Edit discussion'));
  assert.equal($('discussion-actions').textContent.includes('Close discussion'), false);
  assert.equal($('discussion-replies').querySelector('button'), null);
  const before = calls.length;
  for (const control of ['discussion-cancel', 'discussion-editor-close', 'escape', 'backdrop']) {
    exec("openDiscussionEditor('thread')");
    $('discussion-form').elements.body.value = 'Unsaved';
    if (control === 'escape') $('discussion-editor').oncancel({ preventDefault() {} });
    else if (control === 'backdrop') {
      $('discussion-editor').getBoundingClientRect = () => ({
        left: 100,
        right: 500,
        top: 100,
        bottom: 500,
      });
      $('discussion-editor').onclick({ target: $('discussion-editor'), clientX: 0, clientY: 0 });
    } else $(control).onclick();
    assert.equal($('discussion-editor').open, false);
    assert.equal($('discussion-form').elements.body.value, '');
  }
  assert.equal(calls.length, before);
  exec("openDiscussionEditor('thread')");
  const form = $('discussion-form');
  form.elements.title.value = 'New discussion';
  form.elements.body.value = '  ';
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.equal(calls.length, before);
  assert.ok($('discussion-form-error').textContent);
  form.elements.body.value = 'A useful conversation';
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.equal(calls.at(-1).name, 'save_discussion_thread');
  assert.equal(calls.at(-1).args.neighborhood, 'n1');
  assert.equal(calls.at(-1).args.author_user_id, undefined);
  assert.equal($('discussion-editor').open, false);
  assert.equal($('discussion-confirmation').hidden, false);
  exec("openDiscussionEditor('reply')");
  assert.equal(form.elements.title.disabled, true);
  form.elements.body.value = 'My reply';
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.equal(calls.at(-1).name, 'save_discussion_reply');
  assert.equal(calls.at(-1).args.thread, 't2');
  ctx.membership = { role: 'admin' };
  await exec("openDiscussionThread('t1')");
  await [...$('discussion-actions').children]
    .find((b) => b.textContent === 'Close discussion')
    .onclick();
  assert.equal($('discussion-add-reply').hidden, true);
  assert.equal($('discussion-actions').textContent.includes('Edit discussion'), false);
  assert.ok($('discussion-status').textContent.includes('closed'));
  await [...$('discussion-actions').children]
    .find((b) => b.textContent === 'Reopen discussion')
    .onclick();
  assert.equal($('discussion-add-reply').hidden, false);
  assert.ok($('discussion-replies').textContent.includes('Remove'));
  ctx.membership = { role: 'resident' };
  ctx.user = { id: 'other' };
  await exec("openDiscussionThread('t1')");
  assert.equal($('discussion-actions').textContent.includes('Remove discussion'), false);
  assert.ok($('discussion-replies').textContent.includes('Edit'));
  await [...$('discussion-replies').querySelectorAll('button')]
    .find((b) => b.textContent === 'Remove')
    .onclick();
  assert.equal(calls.at(-1).name, 'remove_discussion_reply');
  fail = true;
  await exec('loadDiscussionList()');
  assert.ok($('discussion-error').textContent.includes('being set up'));
  fail = false;
  threads = Array.from({ length: 25 }, (_, i) => ({
    ...threads[0],
    id: 'page' + i,
    title: 'Thread ' + i,
  }));
  await exec('loadDiscussionList()');
  assert.equal(document.querySelectorAll('.discussion-row').length, 20);
  assert.equal($('discussion-more').hidden, false);
  await exec('loadDiscussionList(true)');
  assert.equal(document.querySelectorAll('.discussion-row').length, 25);
  assert.equal($('discussion-more').hidden, true);
  let release;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  const pending = exec('loadDiscussionList()');
  ctx.generation++;
  ctx.user = null;
  ctx.membership = null;
  exec('resetDiscussions()');
  release();
  await pending;
  assert.equal($('discussion-list').textContent, '');
  assert.equal($('discussion-content').textContent, '');
  assert.equal($('discussion-editor').open, false);
  assert.equal($('discussion-confirmation').hidden, true);
  console.log(
    'PASS: discussion list/detail, safe text rendering, author/admin controls, close/reopen, reply writes, editor dismissals, validation, pagination, setup fallback and stale sign-out cleanup.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
