const fs = require('fs'),
  vm = require('vm'),
  assert = require('assert/strict');
const { parseHTML } = require('linkedom');
const root = require('node:path').resolve(__dirname, '..') + '/';
async function setup({ account = 'manager', migrated = true, signed = true } = {}) {
  const { window, document } = parseHTML(fs.readFileSync(root + 'index.html', 'utf8'));
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() {
      return (
        this.querySelector('option[selected]')?.value || this.querySelector('option')?.value || ''
      );
    },
    set(value) {
      this.querySelectorAll('option').forEach((o) => {
        if (o.value === value) o.setAttribute('selected', '');
        else o.removeAttribute('selected');
      });
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'elements', {
    configurable: true,
    get() {
      const els = [...this.querySelectorAll('input,textarea,select,button')];
      els.forEach((el) => {
        if (el.name) els[el.name] = el;
      });
      return els;
    },
  });
  for (const el of document.querySelectorAll('*')) {
    el.scrollIntoView = () => {};
    el.focus = () => {};
    el.reportValidity = () => true;
  }
  const people = [
    {
      id: 'person1',
      household_id: 'home1',
      user_id: 'manager',
      display_name: 'Sam Manager',
      bio: '',
      interests: 'Trees',
      email: '',
      phone: '',
      photo_path: '',
    },
    {
      id: 'person2',
      household_id: 'home1',
      user_id: null,
      display_name: 'Alex <Unlinked>',
      bio: '',
      interests: 'Books',
      email: '',
      phone: '',
      photo_path: '',
    },
    {
      id: 'person3',
      household_id: 'home1',
      user_id: 'member',
      display_name: 'Pat Adult',
      bio: '',
      interests: 'Running',
      email: '',
      phone: '',
      photo_path: '',
    },
  ];
  const homes = [
    {
      ...(migrated ? { photo_preference: 'auto' } : {}),
      id: 'home1',
      neighborhood_id: 'n1',
      display_name: 'Test home',
      address: '1 Test Lane',
      residents: 'Legacy summary',
      bio: '',
      interests: '',
      email: '',
      phone: '',
      latitude: 41,
      longitude: -88,
    },
  ];
  let schemaCalls = 0;
  function from(table) {
    const filters = [];
    let updates;
    const q = {
      select() {
        return this;
      },
      eq(k, v) {
        filters.push([k, v]);
        return this;
      },
      in(k, v) {
        filters.push([k, v]);
        return this;
      },
      order() {
        return this;
      },
      update(p) {
        updates = p;
        return this;
      },
      single() {
        this.one = true;
        return this;
      },
      maybeSingle() {
        this.one = true;
        return this;
      },
      then(resolve) {
        let rows =
          table === 'neighborhoods'
            ? [{ id: 'n1', slug: 'burr-oaks', name: 'Burr Oaks' }]
            : table === 'memberships'
              ? [
                  {
                    user_id: account,
                    neighborhood_id: 'n1',
                    household_id: 'home1',
                    role: account === 'manager' ? 'admin' : 'resident',
                    household_role: account === 'manager' ? 'manager' : 'member',
                  },
                ]
              : table === 'households'
                ? homes
                : table === 'household_members'
                  ? people
                  : [];
        if (table === 'household_members') {
          schemaCalls++;
          if (!migrated)
            return Promise.resolve({ data: null, error: { code: 'PGRST205' } }).then(resolve);
        }
        rows = rows.filter((r) =>
          filters.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)),
        );
        return Promise.resolve({ data: this.one ? rows[0] || null : rows, error: null }).then(
          resolve,
        );
      },
    };
    return q;
  }
  const db = {
    from,
    auth: {
      getSession: async () => ({
        data: {
          session: signed
            ? { user: { id: account, email: 'example@test.invalid', user_metadata: {} } }
            : null,
        },
      }),
      onAuthStateChange() {},
    },
    storage: {
      from() {
        return {
          list: async () => ({ data: [] }),
          createSignedUrl: async () => ({ data: { signedUrl: 'https://test.invalid/photo' } }),
        };
      },
    },
    rpc: async (name, args) => {
      if (name === 'household_login_roles')
        return {
          data: [
            { member_id: 'person1', household_role: 'manager' },
            { member_id: 'person3', household_role: 'member' },
          ],
        };
      if (name === 'save_household_member') {
        const id = args.person || 'person4';
        const p = {
          id,
          household_id: args.household,
          user_id: null,
          display_name: args.person_name,
          bio: args.person_bio,
          interests: args.person_interests,
          email: args.contact_email,
          phone: args.contact_phone,
          photo_path: args.photo,
        };
        const i = people.findIndex((p) => p.id === id);
        if (i >= 0) people[i] = p;
        else people.push(p);
        return { data: id };
      }
      return { data: null };
    },
  };
  window.NC_CONFIG = {
    supabaseUrl: 'test',
    supabaseKey: 'test',
    neighborhoodSlug: 'burr-oaks',
    branding: { name: 'Burr Oaks' },
    center: { lat: 41, lng: -88 },
  };
  window.supabase = { createClient: () => db };
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  class FormDataFake {
    constructor(form) {
      this.entries = [...form.querySelectorAll('input,textarea,select')]
        .filter((x) => x.name && !x.disabled)
        .map((x) => [x.name, x.value || '']);
    }
    get(k) {
      return this.entries.find(([x]) => x === k)?.[1];
    }
    [Symbol.iterator]() {
      return this.entries[Symbol.iterator]();
    }
  }
  const ctx = vm.createContext({
    window,
    document,
    location: { href: 'https://example.test/', hash: '', pathname: '/', search: '' },
    URL,
    URLSearchParams,
    sessionStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    history: { replaceState() {} },
    FormData: FormDataFake,
    console,
    confirm: () => true,
    setTimeout,
    crypto: require('crypto').webcrypto,
    navigator: { clipboard: { writeText: async () => {} } },
  });
  vm.runInContext(fs.readFileSync(root + 'household-photos.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'members.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'app.js', 'utf8').replace('\nrun(load);', ''), ctx);
  vm.runInContext('loadMap=async()=>{}', ctx);
  await vm.runInContext('load()', ctx);
  return { ctx, document, people, getSchemaCalls: () => schemaCalls };
}
(async () => {
  let t = await setup({ signed: false });
  assert.equal(t.document.getElementById('auth').hidden, false);
  assert.equal(t.document.getElementById('directory').hidden, true);
  t = await setup({ migrated: false });
  assert.equal(t.document.getElementById('directory').hidden, false);
  assert.equal(t.document.getElementById('persontab').hidden, true);
  assert.equal(t.document.getElementById('upload').disabled, false);
  t = await setup();
  const { ctx, document } = t;
  vm.runInContext("view('profile')", ctx);
  assert.equal(document.getElementById('household-members').hidden, false);
  assert.equal(document.getElementById('add-member').hidden, false);
  assert.equal(document.querySelectorAll('[data-edit-person]').length, 2);
  assert.equal(document.querySelectorAll('[data-invite-person]').length, 1);
  assert.equal(
    document.getElementById('my-members').innerHTML.includes('Alex &lt;Unlinked&gt;'),
    true,
  );
  vm.runInContext("$('search').value='Running';render()", ctx);
  assert.equal(document.querySelectorAll('#households [data-household]').length, 1);
  await vm.runInContext("detail('home1')", ctx);
  assert.equal(document.querySelectorAll('#detail [data-person]').length, 3);
  vm.runInContext("showMemberDetail('person2')", ctx);
  assert.equal(document.getElementById('detail').textContent.includes('Alex <Unlinked>'), true);
  vm.runInContext("view('person');openMemberEditor(null)", ctx);
  document.querySelector('#memberform input[name=display_name]').value = 'New person';
  document
    .getElementById('memberform')
    .onsubmit({ preventDefault() {}, target: document.getElementById('memberform') });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.people.length, 4);
  assert.equal(document.querySelector('#memberform input[name=display_name]').value, 'New person');
  t = await setup({ account: 'member' });
  vm.runInContext("view('profile')", t.ctx);
  assert.equal(t.document.getElementById('upload').disabled, true);
  assert.equal(t.document.getElementById('add-member').hidden, true);
  assert.equal(t.document.querySelectorAll('[data-edit-person]').length, 1);
  assert.equal(t.document.querySelectorAll('[data-member-action]').length, 0);
  vm.runInContext("view('person')", t.ctx);
  assert.equal(t.document.querySelector('#memberform input[name=display_name]').value, 'Pat Adult');
  vm.runInContext("openMemberEditor('person1')", t.ctx);
  assert.equal(t.document.getElementById('memberform'), null);
  // Shared photo choices: priority, Google attribution, no-image choice, errors and migration fallback.
  const photos = await setup();
  vm.runInContext("cfg.googleMapsKey='test-key';householdPhotosReady.add('home1')", photos.ctx);
  assert.equal(vm.runInContext('householdPhoto(households[0]).source', photos.ctx), 'streetview');
  const url = vm.runInContext('householdPhoto(households[0]).url', photos.ctx);
  assert.equal(new URL(url).searchParams.get('location'), '1 Test Lane');
  assert.equal(new URL(url).searchParams.get('return_error_code'), 'true');
  vm.runInContext(
    "directoryPhotos.set('home1',{url:'https://example.test/upload.jpg'})",
    photos.ctx,
  );
  assert.equal(vm.runInContext('householdPhoto(households[0]).source', photos.ctx), 'uploaded');
  vm.runInContext("households[0].photo_preference='streetview';render()", photos.ctx);
  assert.ok(photos.document.querySelector('#households .google-photo-attribution'));
  assert.equal(
    photos.document.querySelectorAll('#overview-household .overview-avatar[src]').length,
    0,
  );
  const failed = photos.document.querySelector('#households [data-photo-source=streetview]');
  photos.ctx.window.ncHousePhotoError(failed);
  assert.equal(failed.closest('.house-photo').hidden, true);
  assert.equal(vm.runInContext('householdPhoto(households[0])', photos.ctx), null);
  vm.runInContext(
    "households[0].photo_preference='none';failedStreetViews.clear();render()",
    photos.ctx,
  );
  assert.equal(photos.document.querySelectorAll('#households img').length, 0);
  await vm.runInContext("detail('home1')", photos.ctx);
  assert.equal(photos.document.querySelectorAll('#detail img').length, 0);
  vm.runInContext('delete households[0].photo_preference;directoryPhotos.clear()', photos.ctx);
  assert.equal(vm.runInContext('householdPhoto(households[0])', photos.ctx), null);
  console.log(
    'PASS: photo priority, explicit Street View, no-photo choice, attributed rendering, safe avatar, missing-image fallback, pre-migration fallback.',
  );
  const pins = await setup();
  const windows = [];
  pins.ctx.google = {
    maps: {
      InfoWindow: class {
        constructor() {
          windows.push(this);
        }
        setContent(value) {
          this.content = value;
        }
        setOptions(value) {
          this.options = value;
        }
        open(value) {
          this.openOptions = value;
          this.opened = true;
        }
        close() {
          this.opened = false;
        }
      },
      marker: {
        AdvancedMarkerElement: class {
          constructor(options) {
            Object.assign(this, options);
            this.listeners = {};
          }
          addListener(event, fn) {
            this.listeners[event] = fn;
          }
        },
      },
      LatLngBounds: class {
        extend() {}
      },
      event: { addListenerOnce() {} },
    },
  };
  vm.runInContext(
    "map={fitBounds(){}};households[0].phone='(630) 555-0123';drawMarkers(households)",
    pins.ctx,
  );
  vm.runInContext('markers[0].listeners.click()', pins.ctx);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].openOptions.shouldFocus, true);
  assert.equal(
    windows[0].content.querySelector('.pin-popup-phone').getAttribute('href'),
    'tel:6305550123',
  );
  assert.ok(windows[0].content.textContent.includes('Alex <Unlinked>'));
  assert.equal(windows[0].content.querySelector('Unlinked'), null);
  assert.equal(windows[0].content.querySelectorAll('img').length, 0);
  pins.ctx.window.matchMedia = () => ({ matches: true });
  vm.runInContext("markers[0].content.dispatchEvent(new window.Event('mouseenter'))", pins.ctx);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].openOptions.shouldFocus, false);
  vm.runInContext("households[0].phone='';openPinPopup(households[0],markers[0])", pins.ctx);
  assert.equal(windows[0].content.querySelector('.pin-popup-phone'), null);
  let openedHousehold;
  pins.ctx.captureHousehold = (id) => {
    openedHousehold = id;
  };
  vm.runInContext('detail=async(id)=>captureHousehold(id)', pins.ctx);
  windows[0].content.querySelector('button').onclick();
  assert.equal(openedHousehold, 'home1');
  assert.equal(windows[0].opened, false);
  assert.equal(windows[0].content, '');
  vm.runInContext(
    "members=[];households[0].residents='Legacy names';openPinPopup(households[0],markers[0])",
    pins.ctx,
  );
  assert.ok(windows[0].content.textContent.includes('Legacy names'));
  vm.runInContext("view('profile')", pins.ctx);
  assert.equal(windows[0].opened, false);
  vm.runInContext('membership=null;openPinPopup(households[0],markers[0])', pins.ctx);
  assert.equal(windows[0].opened, false);
  console.log(
    'PASS: compact pin popup, click/tap and desktop hover, one reusable popup, safe member text, tap-to-call, missing phone, legacy names, profile link, navigation cleanup, approval guard.',
  );
  console.log(
    'PASS: signed-out privacy, pre-migration fallback, manager/member controls, household/member details, escaped names, member search, member creation, personal-profile navigation.',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
