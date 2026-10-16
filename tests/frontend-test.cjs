const fs = require('fs'),
  vm = require('vm'),
  assert = require('assert/strict');
const { parseHTML } = require('linkedom');
const root = require('node:path').resolve(__dirname, '..') + '/';
async function setup({
  account = 'manager',
  migrated = true,
  signed = true,
  approved = true,
  geocoding = false,
  beforeLoad,
  waitForLoad = true,
  homeCount = 1,
  photoFiles = [],
} = {}) {
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
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.close = () => {
      dialog.open = false;
    };
    dialog.showModal = () => {
      dialog.open = true;
    };
  }
  const requests = [];
  const calls = [];
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
  for (let i = 2; i <= homeCount; i++)
    homes.push({
      ...homes[0],
      id: 'home' + i,
      display_name: 'Household ' + i,
      address: i + ' Test Lane',
    });
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
      range() {
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
                  : table === 'access_requests'
                    ? requests
                    : [];
        if (table === 'memberships' && !approved) rows = [];
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
      getUser: async () => ({
        data: {
          user: {
            id: account,
            email: 'example@test.invalid',
            email_confirmed_at: '2026-01-01',
            user_metadata: {},
          },
        },
      }),
      signInWithPassword: async (args) => {
        calls.push({ name: 'signInWithPassword', args });
        return { data: { user: { id: account } } };
      },
      updateUser: async (args, options) => {
        calls.push({ name: 'updateUser', args, options });
        return { data: { user: { id: account } } };
      },
      signOut: async (args) => {
        calls.push({ name: 'signOut', args });
        return { data: null };
      },
      resetPasswordForEmail: async (email, options) => {
        calls.push({ name: 'resetPasswordForEmail', args: { email, options } });
        return { data: {} };
      },
      onAuthStateChange() {},
    },
    storage: {
      from(bucket) {
        return {
          list: async (id) => {
            calls.push({ name: 'photo-list', bucket, id });
            return { data: photoFiles };
          },
          createSignedUrl: async (path) => {
            calls.push({ name: 'photo-sign', bucket, path });
            return { data: { signedUrl: 'https://test.invalid/photo' } };
          },
        };
      },
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'account_settings')
        return {
          data: {
            contact: approved
              ? {
                  email: 'private@test.invalid',
                  phone: '123',
                  share_email: false,
                  share_phone: false,
                }
              : null,
            deletion_blocker:
              'Give another household login manager access in My Household before deleting your account.',
          },
        };
      if (name === 'geocoding_ready') return { data: geocoding };
      if (name === 'request_access') {
        requests.push({
          id: 'request1',
          user_id: account,
          neighborhood_id: 'n1',
          name: args.resident_name,
          address: args.household_address,
          status: 'pending',
        });
        return { data: null };
      }
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
    clearTimeout,
    crypto: require('crypto').webcrypto,
    navigator: { clipboard: { writeText: async () => {} } },
  });
  vm.runInContext(fs.readFileSync(root + 'geocoding.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'household-photos.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'members.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'account-settings.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'calendar.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'discussions.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(root + 'app.js', 'utf8').replace('\nrun(load);', ''), ctx);
  vm.runInContext('loadMap=async()=>{}', ctx);
  if (beforeLoad) await beforeLoad({ ctx, document, db });
  const loadPromise = vm.runInContext('load()', ctx);
  if (waitForLoad) await loadPromise;
  return {
    ctx,
    document,
    people,
    calls,
    requests,
    db,
    loadPromise,
    getSchemaCalls: () => schemaCalls,
  };
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
  const geo = await setup();
  geo.ctx.geocodeResults = [
    {
      address_components: [{ types: ['street_number'] }, { types: ['route'] }],
      geometry: { location_type: 'ROOFTOP', location: { lat: () => 41, lng: () => -88 } },
    },
  ];
  geo.ctx.google = {
    maps: {
      Geocoder: class {
        async geocode() {
          return { results: geo.ctx.geocodeResults };
        }
      },
      LatLngBounds: class {},
    },
  };
  vm.runInContext('ensureGoogleMaps=async()=>{};cfg.center={lat:41,lng:-88}', geo.ctx);
  const found = await vm.runInContext("geocodeAddress('1 Test Lane')", geo.ctx);
  assert.equal(found.latitude, 41);
  assert.equal(found.longitude, -88);
  geo.ctx.geocodeResults = [{ ...geo.ctx.geocodeResults[0], partial_match: true }];
  await assert.rejects(
    vm.runInContext("geocodeAddress('Partial address')", geo.ctx),
    /complete address match/,
  );
  geo.ctx.geocodeResults = [];
  await assert.rejects(
    vm.runInContext("geocodeAddress('Missing address')", geo.ctx),
    /complete address match/,
  );
  geo.ctx.geocodeResults = [
    {
      address_components: [{ types: ['street_number'] }, { types: ['route'] }],
      geometry: { location_type: 'APPROXIMATE', location: { lat: () => 41, lng: () => -88 } },
    },
  ];
  await assert.rejects(
    vm.runInContext("geocodeAddress('Approximate')", geo.ctx),
    /rather than a house/,
  );
  geo.ctx.geocodeResults[0].geometry.location_type = 'ROOFTOP';
  geo.ctx.geocodeResults[0].geometry.location.lat = () => 42;
  await assert.rejects(
    vm.runInContext("geocodeAddress('Far away')", geo.ctx),
    /outside the neighborhood area/,
  );
  vm.runInContext(
    "households[0].location_source='google';applyHouseholdLocations([{household_id:'home1',latitude:41.1,longitude:-88.1,expires_at:new Date(Date.now()-1000).toISOString()}])",
    geo.ctx,
  );
  assert.equal(vm.runInContext('households[0].latitude', geo.ctx), null);
  vm.runInContext(
    "applyHouseholdLocations([{household_id:'home1',latitude:41,longitude:-88,expires_at:new Date(Date.now()+10000).toISOString()}])",
    geo.ctx,
  );
  assert.equal(vm.runInContext('hasCurrentHouseholdLocation(households[0])', geo.ctx), true);
  vm.runInContext(
    'households[0].location_expires_at=new Date(Date.now()-1000).toISOString();expireLocalLocations()',
    geo.ctx,
  );
  assert.equal(vm.runInContext('households[0].latitude', geo.ctx), null);
  const controls = geo.document.createElement('form');
  controls.dataset.request = 'test-request';
  controls.innerHTML =
    vm.runInContext('geocodingEnabled=true;requestLocationControls({})', geo.ctx) +
    `<select name="household"><option value="">New home</option><option value="home1">Existing home</option></select><div class="coordinates"><input name="lat"><input name="lng"></div>`;
  geo.document.getElementById('requests').append(controls);
  geo.ctx.formForTest = controls;
  vm.runInContext(
    "requestLocations.set('test-request',{latitude:41,longitude:-88});formForTest.elements.manual.checked=false;fillRequestLocation(formForTest)",
    geo.ctx,
  );
  assert.equal(controls.elements.lat.value, '41');
  assert.equal(controls.elements.verified.required, true);
  assert.equal(controls.querySelector('[data-location-link]').hidden, false);
  controls.elements.household.value = 'home1';
  vm.runInContext('fillRequestLocation(formForTest)', geo.ctx);
  assert.equal(controls.querySelector('.coordinates').hidden, true);
  assert.equal(controls.elements.verified.required, false);
  console.log(
    'PASS: exact house lookup, partial/missing/coarse/far-away rejection, fresh/expired positions, reviewed candidate fields, existing-household reuse controls.',
  );
  const signup = await setup({ account: 'applicant', approved: false, geocoding: true });
  signup.ctx.google = {
    maps: {
      Geocoder: class {
        async geocode() {
          return {
            results: [
              {
                address_components: [{ types: ['street_number'] }, { types: ['route'] }],
                geometry: { location_type: 'ROOFTOP', location: { lat: () => 41, lng: () => -88 } },
              },
            ],
          };
        }
      },
      LatLngBounds: class {},
    },
  };
  vm.runInContext('ensureGoogleMaps=async()=>{}', signup.ctx);
  signup.document.querySelector('#joinform [name=name]').value = 'New Resident';
  signup.document.querySelector('#joinform [name=address]').value = '1 Test Lane';
  signup.document
    .getElementById('joinform')
    .onsubmit({ preventDefault() {}, target: signup.document.getElementById('joinform') });
  await new Promise(setImmediate);
  assert.equal(signup.requests.length, 1);
  assert.equal(
    signup.calls.some(
      (c) =>
        c.name === 'save_request_geocode' && c.args.lat === 41 && c.args.request_id === 'request1',
    ),
    true,
  );
  assert.equal(signup.document.getElementById('pending').hidden, false);
  assert.ok(signup.document.getElementById('notice').textContent.includes('proposed house pin'));
  const failedSignup = await setup({ account: 'applicant2', approved: false, geocoding: true });
  vm.runInContext(
    "geocodeAddress=async()=>{throw new Error('Google unavailable')}",
    failedSignup.ctx,
  );
  failedSignup.document.querySelector('#joinform [name=name]').value = 'Another Resident';
  failedSignup.document.querySelector('#joinform [name=address]').value = '2 Test Lane';
  failedSignup.document
    .getElementById('joinform')
    .onsubmit({ preventDefault() {}, target: failedSignup.document.getElementById('joinform') });
  await new Promise(setImmediate);
  assert.equal(failedSignup.requests.length, 1);
  assert.equal(
    failedSignup.calls.some((c) => c.name === 'save_request_geocode'),
    false,
  );
  assert.equal(failedSignup.document.getElementById('pending').hidden, false);
  console.log(
    'PASS: signup automatically saves proposed coordinates; lookup failures preserve the pending access request.',
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
  pins.ctx.window.matchMedia = () => ({ matches: true });
  vm.runInContext("markers[0].content.dispatchEvent(new window.Event('mouseenter'))", pins.ctx);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].openOptions.shouldFocus, false);
  assert.equal(windows[0].content.querySelector('.pin-popup-title').textContent, 'Test home');
  assert.equal(windows[0].content.querySelector('.pin-popup-address').textContent, '1 Test Lane');
  vm.runInContext("markers[0].content.dispatchEvent(new window.Event('mouseleave'))", pins.ctx);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(windows[0].opened, false, 'Hover popup closes after leaving the pin.');
  pins.ctx.window.matchMedia = () => ({ matches: true });
  vm.runInContext("markers[0].content.dispatchEvent(new window.Event('mouseenter'))", pins.ctx);
  vm.runInContext("markers[0].content.dispatchEvent(new window.Event('mouseleave'))", pins.ctx);
  windows[0].content.dispatchEvent(new pins.ctx.window.Event('mouseenter'));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(windows[0].opened, true, 'Popup remains usable while hovering its contents.');
  windows[0].content.dispatchEvent(new pins.ctx.window.Event('mouseleave'));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(windows[0].opened, false);
  vm.runInContext(
    "markers[0].listeners.click();markers[0].content.dispatchEvent(new window.Event('mouseleave'))",
    pins.ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(windows[0].opened, true, 'Click/tap popup remains available for interaction.');

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
  vm.runInContext("households[0].residents='';openPinPopup(households[0],markers[0])", pins.ctx);
  assert.equal(windows[0].content.querySelector('.pin-popup-members'), null);
  assert.ok(windows[0].content.textContent.includes('Test home'));
  assert.ok(windows[0].content.textContent.includes('1 Test Lane'));
  assert.equal(windows[0].content.textContent.includes('Members not listed'), false);
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

(async () => {
  const { ctx, document, calls } = await setup();
  vm.runInContext("view('settings')", ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(document.getElementById('settings').hidden, false);
  assert.equal(document.getElementById('directory').hidden, true);
  assert.equal(document.getElementById('settings-email').textContent, 'example@test.invalid');
  assert.equal(
    document.getElementById('account-contacts-form').elements.contact_email.value,
    'private@test.invalid',
  );
  assert.equal(
    document.getElementById('account-contacts-form').elements.share_email.checked,
    false,
  );
  assert.equal(document.getElementById('account-delete-form').hidden, true);
  assert.equal(document.getElementById('settings-menu').hidden, false);
  assert.equal(document.getElementById('settings-detail').hidden, true);
  for (const page of ['email', 'password', 'contacts', 'sessions', 'delete']) {
    document.querySelector(`[data-account-page="${page}"]`).onclick({ preventDefault() {} });
    assert.equal(document.getElementById('settings-menu').hidden, true);
    assert.equal(document.getElementById('settings-detail').hidden, false);
    assert.equal(document.getElementById(`account-${page}`).hidden, false);
    assert.equal(document.querySelectorAll('[data-account-settings-page]:not([hidden])').length, 1);
    assert.equal(document.getElementById('settings-email').textContent, 'example@test.invalid');
  }
  document.getElementById('account-delete-form').elements.confirmation.value = 'DELETE';
  document.getElementById('account-password-form').elements.current_password.value = 'unsaved';
  document.getElementById('settings-menu-back').onclick();
  assert.equal(document.getElementById('settings-menu').hidden, false);
  assert.equal(document.getElementById('settings-detail').hidden, true);
  assert.equal(document.getElementById('account-delete-form').elements.confirmation.value, '');
  assert.equal(
    document.getElementById('account-password-form').elements.current_password.value,
    '',
  );
  document.querySelector('[data-account-page="password"]').onclick({ preventDefault() {} });
  const form = document.getElementById('account-password-form');
  form.elements.current_password.value = 'current-pass';
  form.elements.password.value = 'new-password-long';
  form.elements.confirm_password.value = 'does-not-match';
  form.onsubmit({ preventDefault() {}, target: form });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    calls.some((c) => c.name === 'updateUser'),
    false,
  );
  form.elements.current_password.value = 'current-pass';
  form.elements.password.value = 'new-password-long';
  form.elements.confirm_password.value = 'new-password-long';
  form.onsubmit({ preventDefault() {}, target: form });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.find((c) => c.name === 'updateUser').args.password, 'new-password-long');
  assert.equal(form.elements.current_password.value, '');
  const pending = await setup({ approved: false });
  vm.runInContext("view('settings')", pending.ctx);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(pending.document.getElementById('settings').hidden, false);
  assert.equal(pending.document.getElementById('join').hidden, true);
  vm.runInContext('clearAccountSettings()', ctx);
  assert.equal(document.getElementById('settings-email').textContent, '');
  console.log(
    'PASS: private settings routing, pending-user access, hidden contact controls, deletion handoff, password match/check and secret clearing.',
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

(async () => {
  const { ctx, document } = await setup();
  const toggle = document.getElementById('search-toggle');
  const panel = document.getElementById('directory-search');
  assert.equal(toggle.hidden, false);
  assert.equal(panel.hidden, true);
  toggle.onclick();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  document.getElementById('search').value = 'Alex';
  document.getElementById('search').oninput();
  assert.equal(document.getElementById('browse').hidden, false);
  assert.equal(panel.hidden, false);
  const escape = new document.defaultView.Event('keydown', { bubbles: true });
  escape.key = 'Escape';
  document.dispatchEvent(escape);
  assert.equal(panel.hidden, true);
  toggle.onclick();
  document.body.dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
  assert.equal(panel.hidden, true);
  toggle.onclick();
  vm.runInContext("view('profile')", ctx);
  assert.equal(panel.hidden, true);
  assert.equal(toggle.hidden, true);
  const signedOut = await setup({ signed: false });
  assert.equal(signedOut.document.getElementById('search-toggle').hidden, true);
  assert.equal(signedOut.document.getElementById('directory-search').hidden, true);
  console.log(
    'PASS: compact search toggling, filtering, Escape, outside click, navigation and signed-out hiding.',
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

(async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const flush = () => new Promise(setImmediate);
  const membersGate = deferred(),
    locationsGate = deferred(),
    photosGate = deferred();
  const t = await setup({
    waitForLoad: false,
    beforeLoad: ({ ctx }) => {
      ctx.membersGate = membersGate.promise;
      ctx.locationsGate = locationsGate.promise;
      ctx.photosGate = photosGate.promise;
      vm.runInContext(
        `
        const originalMembers = loadHouseholdMembers;
        const originalLocations = loadHouseholdLocations;
        const originalPhotos = loadDirectoryPhotos;
        loadHouseholdMembers = async (v) => { await membersGate; return originalMembers(v); };
        loadHouseholdLocations = async (v) => { await locationsGate; return originalLocations(v); };
        loadDirectoryPhotos = async (v) => { await photosGate; return originalPhotos(v); };
      `,
        ctx,
      );
    },
  });
  await flush();
  assert.equal(t.document.getElementById('directory').hidden, false);
  assert.equal(t.document.getElementById('startup-loading').hidden, true);
  assert.equal(t.document.getElementById('overview-edit').disabled, true);
  assert.equal(t.document.getElementById('profileform').elements.display_name.disabled, true);
  assert.ok(
    t.document.getElementById('overview-household').textContent.includes('Loading members'),
  );
  assert.ok(
    vm.runInContext('startupTrace', t.ctx).stages.some((r) => r.stage === 'Main content visible'),
  );
  assert.equal(
    vm
      .runInContext('startupTrace', t.ctx)
      .stages.find((r) => r.stage === 'Members, roles and member photos').state,
    'loading',
  );
  vm.runInContext("view('browse')", t.ctx);
  membersGate.resolve();
  locationsGate.resolve();
  photosGate.resolve();
  await t.loadPromise;
  assert.equal(t.document.getElementById('browse').hidden, false);
  assert.equal(t.document.getElementById('overview').hidden, true);
  assert.equal(t.document.getElementById('profileform').elements.display_name.disabled, false);
  assert.equal(vm.runInContext('startupTrace', t.ctx).state, 'ready');
  assert.equal(typeof vm.runInContext('startupTrace', t.ctx).report, 'function');
  const diagnosticText = JSON.stringify(vm.runInContext('startupTrace', t.ctx));
  assert.equal(diagnosticText.includes('example@test.invalid'), false);
  assert.equal(diagnosticText.includes('1 Test Lane'), false);
  assert.equal(diagnosticText.includes('Sam Manager'), false);

  const late = deferred();
  const stale = await setup({
    waitForLoad: false,
    beforeLoad: ({ ctx }) => {
      ctx.late = late.promise;
      vm.runInContext(
        `const original = loadHouseholdMembers;
      loadHouseholdMembers = async (v) => { await late; return original(v); };`,
        ctx,
      );
    },
  });
  await flush();
  stale.db.auth.getSession = async () => ({ data: { session: null } });
  await vm.runInContext('load()', stale.ctx);
  late.resolve();
  await stale.loadPromise;
  assert.equal(stale.document.getElementById('directory').hidden, true);
  assert.equal(stale.document.getElementById('auth').hidden, false);
  assert.equal(vm.runInContext('members.length', stale.ctx), 0);
  assert.equal(vm.runInContext('households.length', stale.ctx), 0);

  const gate = deferred();
  const auth = await setup({
    waitForLoad: false,
    beforeLoad: ({ db }) => {
      const original = db.auth.getSession;
      db.auth.getSession = async () => {
        await gate.promise;
        return original();
      };
    },
  });
  await flush();
  assert.equal(auth.document.getElementById('directory').hidden, true);
  assert.equal(auth.document.getElementById('startup-loading').hidden, false);
  gate.resolve();
  await auth.loadPromise;

  const failure = await setup({
    beforeLoad: ({ ctx }) => {
      vm.runInContext("loadHouseholdMembers = async () => { throw Error('Test failure'); }", ctx);
    },
  });
  assert.equal(failure.document.getElementById('directory').hidden, false);
  assert.equal(failure.document.getElementById('startup-loading').hidden, true);
  assert.equal(failure.document.getElementById('overview-edit').disabled, true);
  assert.ok(failure.document.getElementById('notice').textContent.includes('some details'));
  assert.equal(
    vm
      .runInContext('startupTrace', failure.ctx)
      .stages.find((r) => r.stage === 'Members, roles and member photos').state,
    'failed',
  );
  console.log(
    'PASS: progressive first content before secondary requests, permission gates, navigation preservation, stale sign-out responses, auth loading placeholders, secondary failure isolation and private-data-free startup timings.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

(async () => {
  const t = await setup({ homeCount: 24, photoFiles: [{ id: 'file1', name: 'primary.jpg' }] });
  const lists = () =>
    t.calls.filter((c) => c.name === 'photo-list' && c.bucket === 'household-photos');
  const signs = () =>
    t.calls.filter((c) => c.name === 'photo-sign' && c.bucket === 'household-photos');
  assert.equal(lists().length, 4, 'Startup lists only own household and three featured neighbors.');
  assert.deepEqual(
    lists()
      .map((c) => c.id)
      .sort(),
    ['home1', 'home2', 'home3', 'home4'],
  );
  assert.equal(signs().length, 4, 'My photos and Home reuse signed URLs.');
  vm.runInContext("view('browse')", t.ctx);
  await new Promise(setImmediate);
  assert.equal(lists().length, 24);
  assert.equal(
    new Set(lists().map((c) => c.id)).size,
    24,
    'Concurrent loads share each photo-list request.',
  );
  vm.runInContext("view('overview'); view('browse')", t.ctx);
  await vm.runInContext("loadDirectoryPhotos(generation, 'directory')", t.ctx);
  assert.equal(lists().length, 24, 'Revisiting views reuses recent results.');
  await vm.runInContext("invalidateHouseholdPhoto('home1'); refreshHouseholdPhoto('home1')", t.ctx);
  assert.equal(lists().length, 25, 'Photo changes invalidate metadata.');
  assert.equal(signs().length, 25, 'Photo changes invalidate signed URLs.');
  await vm.runInContext(
    "photoChecks.set('home2', 0); photoListCache.get('home2').expires = 0; photoUrlCache.get('home2/primary.jpg').expires = 0; loadDirectoryPhotos(generation, 'directory')",
    t.ctx,
  );
  assert.equal(lists().length, 26, 'Expired metadata can refresh.');
  assert.equal(signs().length, 26, 'Expired signed URLs are renewed.');
  t.db.auth.getSession = async () => ({ data: { session: null } });
  await vm.runInContext('load()', t.ctx);
  assert.equal(
    vm.runInContext(
      'photoListCache.size + photoUrlCache.size + photoChecks.size + photoLoads.size',
      t.ctx,
    ),
    0,
  );

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const late = await setup({
    homeCount: 24,
    waitForLoad: false,
    beforeLoad: ({ db }) => {
      const original = db.storage.from;
      db.storage.from = (bucket) => {
        const storage = original(bucket);
        return {
          ...storage,
          list: async (id, options) => {
            await gate;
            return storage.list(id, options);
          },
        };
      };
    },
  });
  await new Promise(setImmediate);
  late.db.auth.getSession = async () => ({ data: { session: null } });
  await vm.runInContext('load()', late.ctx);
  release();
  await late.loadPromise;
  assert.equal(
    vm.runInContext('directoryPhotos.size + photoListCache.size + photoUrlCache.size', late.ctx),
    0,
  );
  assert.equal(late.document.getElementById('directory').hidden, true);
  const stopped = await setup({ homeCount: 24 });
  let finishDirectory;
  const directoryGate = new Promise((resolve) => {
    finishDirectory = resolve;
  });
  const originalStorage = stopped.db.storage.from;
  stopped.db.storage.from = (bucket) => {
    const storage = originalStorage(bucket);
    return {
      ...storage,
      list: async (id, options) => {
        if (!['home1', 'home2', 'home3', 'home4'].includes(id)) await directoryGate;
        return storage.list(id, options);
      },
    };
  };
  vm.runInContext("view('browse')", stopped.ctx);
  const batch = vm.runInContext("loadDirectoryPhotos(generation, 'directory')", stopped.ctx);
  await new Promise(setImmediate);
  vm.runInContext("view('profile')", stopped.ctx);
  finishDirectory();
  await batch;
  const stoppedCalls = stopped.calls.filter((c) => c.name === 'photo-list');
  assert.equal(
    stoppedCalls.length,
    8,
    'Leaving Directory stops scheduling beyond the four in-flight requests.',
  );
  console.log(
    'PASS: four household photo checks on Home regardless of neighborhood size, deferred directory photos, request deduplication, signed URL reuse/expiry, mutation invalidation and sign-out safety.',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

(async () => {
  const t = await setup();
  vm.runInContext("view('discussions')", t.ctx);
  await new Promise(setImmediate);
  assert.equal(t.document.getElementById('discussions').hidden, false);
  assert.equal(t.document.getElementById('directory').hidden, true);
  assert.equal(t.document.getElementById('calendar').hidden, true);
  assert.equal(t.document.getElementById('search-toggle').hidden, true);
  assert.ok(t.document.getElementById('discussion-status').textContent.includes('No discussions'));
  vm.runInContext("view('overview')", t.ctx);
  assert.equal(t.document.getElementById('discussions').hidden, true);
  const pending = await setup({ approved: false });
  vm.runInContext("view('discussions')", pending.ctx);
  assert.equal(pending.document.getElementById('discussions').hidden, true);
  console.log('PASS: Discussions navigation, neighboring page isolation and pending-user gating.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

(async () => {
  const { ctx, document, calls } = await setup({ signed: false });
  const $ = (id) => document.getElementById(id);
  $('authform').elements.email.value = 'example@test.invalid';
  $('authform').elements.password.value = 'unsaved-password';
  $('reset').onclick();
  assert.equal($('auth').hidden, true);
  assert.equal($('password-reset').hidden, false);
  assert.equal($('password-reset-form').elements.email.value, 'example@test.invalid');
  assert.equal($('authform').elements.password.value, '');
  assert.equal(
    calls.some((c) => c.name === 'resetPasswordForEmail'),
    false,
  );
  const form = $('password-reset-form');
  await form.onsubmit({ preventDefault() {}, target: form });
  assert.equal(
    calls.find((c) => c.name === 'resetPasswordForEmail').args.email,
    'example@test.invalid',
  );
  assert.ok($('password-reset-status').textContent.includes('If an account exists'));
  assert.equal($('password-reset-send').disabled, false);
  $('password-reset-back').onclick();
  assert.equal($('auth').hidden, false);
  assert.equal($('password-reset').hidden, true);
  assert.equal(form.elements.email.value, '');
  assert.equal($('password-reset-status').textContent, '');
  $('reset').onclick();
  let release;
  ctx.pendingReset = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  vm.runInContext('db.auth.resetPasswordForEmail = pendingReset', ctx);
  const pending = form.onsubmit({ preventDefault() {}, target: form });
  assert.equal($('password-reset-send').disabled, true);
  $('password-reset-back').onclick();
  release({ data: {} });
  await pending;
  assert.equal($('password-reset-status').textContent, '');
  const signed = await setup();
  vm.runInContext("view('settings')", signed.ctx);
  await new Promise((r) => setTimeout(r, 5));
  signed.document.getElementById('account-reset-password').onclick();
  assert.equal(signed.document.getElementById('settings').hidden, true);
  assert.equal(signed.document.getElementById('password-reset').hidden, false);
  assert.equal(
    signed.document.getElementById('password-reset-form').elements.email.value,
    'example@test.invalid',
  );
  assert.equal(
    signed.calls.some((c) => c.name === 'resetPasswordForEmail'),
    false,
  );
  signed.document.getElementById('password-reset-back').onclick();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(signed.document.getElementById('settings').hidden, false);
  assert.equal(signed.document.getElementById('account-password').hidden, false);
  assert.equal(signed.document.getElementById('settings-menu').hidden, true);
  console.log(
    'PASS: dedicated password reset from sign-in/settings, email prefill, explicit send, inline confirmation, back navigation, password clearing and stale request isolation.',
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
