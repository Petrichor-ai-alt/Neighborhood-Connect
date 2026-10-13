'use strict';
let geocodingEnabled = false;
let addressGeocoder;
let locationExpiryTimer;
const requestLocations = new Map();
const attemptedRequestLookups = new Set();

async function loadGeocodingCapability(version) {
  const result = await db.rpc('geocoding_ready');
  if (version !== generation) return;
  if (result.error && ['PGRST202', '42883'].includes(result.error.code)) {
    geocodingEnabled = false;
    return;
  }
  geocodingEnabled = checked(result) === true;
}

async function geocodeAddress(address) {
  await ensureGoogleMaps();
  if (!addressGeocoder) addressGeocoder = new google.maps.Geocoder();
  const bounds = new google.maps.LatLngBounds(
    { lat: cfg.center.lat - 0.04, lng: cfg.center.lng - 0.04 },
    { lat: cfg.center.lat + 0.04, lng: cfg.center.lng + 0.04 },
  );
  let timeout;
  try {
    const response = await Promise.race([
      addressGeocoder.geocode({ address, bounds, componentRestrictions: { country: 'US' } }),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error('Address lookup timed out. Try again or enter coordinates manually.')),
          20000,
        );
      }),
    ]);
    const results = response.results || [];
    if (results.length !== 1 || results[0].partial_match) {
      throw new Error(
        'Google could not find one complete address match. Check the address or enter verified coordinates manually.',
      );
    }
    const result = results[0];
    const components = result.address_components || [];
    const hasStreetNumber = components.some((c) => c.types.includes('street_number'));
    const hasStreet = components.some((c) => c.types.includes('route'));
    if (
      !hasStreetNumber ||
      !hasStreet ||
      !['ROOFTOP', 'RANGE_INTERPOLATED'].includes(result.geometry?.location_type)
    ) {
      throw new Error(
        'Google returned an approximate area rather than a house. Enter verified coordinates manually.',
      );
    }
    const latitude = result.geometry.location.lat();
    const longitude = result.geometry.location.lng();
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude - cfg.center.lat) > 0.04 ||
      Math.abs(longitude - cfg.center.lng) > 0.04
    ) {
      throw new Error(
        'The proposed location is outside the neighborhood area. Check the address or enter verified coordinates manually.',
      );
    }
    return { latitude, longitude };
  } finally {
    clearTimeout(timeout);
  }
}

function applyHouseholdLocations(rows) {
  const active = new Map(
    rows
      .filter((p) => new Date(p.expires_at).getTime() > Date.now())
      .map((p) => [p.household_id, p]),
  );
  households = households.map((h) => {
    if (h.location_source !== 'google') return h;
    const p = active.get(h.id);
    return {
      ...h,
      latitude: p?.latitude ?? null,
      longitude: p?.longitude ?? null,
      location_expires_at: p?.expires_at ?? null,
    };
  });
}

function hasCurrentHouseholdLocation(h) {
  return (
    Number.isFinite(h.latitude) &&
    Number.isFinite(h.longitude) &&
    (h.location_source !== 'google' || new Date(h.location_expires_at).getTime() > Date.now())
  );
}
function expireLocalLocations() {
  let changed = false;
  households = households.map((h) => {
    if (h.location_source !== 'google' || hasCurrentHouseholdLocation(h)) return h;
    changed ||= h.latitude !== null || h.longitude !== null;
    return { ...h, latitude: null, longitude: null, location_expires_at: null };
  });
  for (const [id, p] of requestLocations) {
    if (new Date(p.expires_at).getTime() <= Date.now()) requestLocations.delete(id);
  }
  if (changed && map && membership)
    drawMarkers(!$('overview').hidden ? households : visibleHouseholds());
}
function scheduleLocalLocationExpiry(version) {
  clearTimeout(locationExpiryTimer);
  locationExpiryTimer = setTimeout(() => {
    if (version !== generation || !user) return;
    expireLocalLocations();
    scheduleLocalLocationExpiry(version);
  }, 3600000);
  locationExpiryTimer.unref?.();
}
async function loadHouseholdLocations(version) {
  if (!geocodingEnabled) return;
  const ids = households.filter((h) => h.location_source === 'google').map((h) => h.id);
  if (!ids.length) return;
  let locations = checked(await db.from('geocoded_locations').select('*').in('household_id', ids));
  if (version !== generation || !membership) return;
  if (membership.role === 'admin') {
    const cached = new Map(locations.map((p) => [p.household_id, p]));
    const queue = households.filter(
      (h) =>
        h.location_source === 'google' &&
        (!cached.has(h.id) ||
          new Date(cached.get(h.id).expires_at).getTime() < Date.now() + 86400000),
    );
    await Promise.all(
      Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (queue.length && version === generation && membership?.role === 'admin') {
          const h = queue.shift();
          try {
            const p = await geocodeAddress(h.address);
            if (version !== generation || membership?.role !== 'admin') return;
            checked(
              await db.rpc('refresh_household_geocode', {
                household: h.id,
                lat: p.latitude,
                lng: p.longitude,
              }),
            );
          } catch (e) {
            notice(
              'Some household pins could not be refreshed. Check Google Geocoding API access or the household address.',
              true,
            );
          }
        }
      }),
    );
    if (version !== generation || !membership) return;
    locations = checked(await db.from('geocoded_locations').select('*').in('household_id', ids));
  }
  if (version === generation && membership) {
    applyHouseholdLocations(locations);
    scheduleLocalLocationExpiry(version);
  }
}

async function saveSignupLocation(address, version) {
  if (!geocodingEnabled) return false;
  const request = checked(
    await db
      .from('access_requests')
      .select('id')
      .eq('user_id', user.id)
      .eq('neighborhood_id', neighborhood.id)
      .single(),
  );
  const p = await geocodeAddress(address);
  if (version !== generation || !user) return false;
  checked(
    await db.rpc('save_request_geocode', {
      request_id: request.id,
      lat: p.latitude,
      lng: p.longitude,
    }),
  );
  return true;
}

function requestLocationControls(r) {
  if (!geocodingEnabled) return '';
  return `<div class="request-location"><button type="button" data-lookup>Look up address</button><p data-location-status></p><a data-location-link target="_blank" rel="noopener noreferrer" hidden>Review proposed pin in Google Maps ↗</a><label class="location-confirmation"><input name="manual" type="checkbox" checked>Enter coordinates manually</label><label class="location-confirmation"><input name="verified" type="checkbox">I checked the pin and confirmed this address is in the neighborhood.</label></div>`;
}

function fillRequestLocation(form) {
  if (!geocodingEnabled) return;
  const p = requestLocations.get(form.dataset.request);
  const existing = !!form.elements.household.value;
  const manual = form.elements.manual.checked;
  form.querySelector('.coordinates').hidden = existing;
  form.querySelector('.request-location').hidden = existing;
  form.elements.verified.required = !existing;
  form.elements.lat.readOnly = !manual;
  form.elements.lng.readOnly = !manual;
  const link = form.querySelector('[data-location-link]');
  link.hidden = !p || existing || manual;
  if (p) {
    link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.latitude + ',' + p.longitude)}`;
    if (!manual) {
      form.elements.lat.value = p.latitude;
      form.elements.lng.value = p.longitude;
    }
  }
  form.querySelector('[data-location-status]').textContent = manual
    ? 'Enter verified coordinates, then check neighborhood eligibility.'
    : p
      ? 'Google Maps proposed this pin. Review it before approval.'
      : 'Look up this address before approving, or choose manual coordinates.';
}

async function lookupRequestLocation(form, r) {
  const button = form.querySelector('[data-lookup]');
  const version = generation;
  button.disabled = true;
  try {
    const p = await geocodeAddress(r.address);
    if (version !== generation || membership?.role !== 'admin') return;
    checked(
      await db.rpc('save_request_geocode', { request_id: r.id, lat: p.latitude, lng: p.longitude }),
    );
    requestLocations.set(r.id, {
      ...p,
      expires_at: new Date(Date.now() + 29 * 86400000).toISOString(),
    });
    scheduleLocalLocationExpiry(version);
    form.elements.manual.checked = false;
    form.elements.verified.checked = false;
    fillRequestLocation(form);
  } catch (e) {
    if (version === generation)
      form.querySelector('[data-location-status]').textContent =
        e.message || 'Address lookup failed. Enter verified coordinates manually.';
  } finally {
    button.disabled = false;
  }
}

async function prepareRequestLocations(rows, version) {
  requestLocations.clear();
  if (!geocodingEnabled || !rows.length) return;
  const locations = checked(
    await db
      .from('geocoded_locations')
      .select('*')
      .in(
        'request_id',
        rows.map((r) => r.id),
      ),
  );
  if (version !== generation || membership?.role !== 'admin') return;
  locations
    .filter((p) => new Date(p.expires_at).getTime() > Date.now())
    .forEach((p) => requestLocations.set(p.request_id, p));
  for (const r of rows) {
    const form = $('requests').querySelector(`[data-request="${r.id}"]`);
    if (!form) continue;
    form.elements.manual.checked = !requestLocations.has(r.id);
    fillRequestLocation(form);
    form.elements.household.onchange = () => fillRequestLocation(form);
    form.elements.manual.onchange = () => {
      form.elements.verified.checked = false;
      if (form.elements.manual.checked) {
        form.elements.lat.value = '';
        form.elements.lng.value = '';
      }
      fillRequestLocation(form);
    };
    form.querySelector('[data-lookup]').onclick = () => {
      attemptedRequestLookups.add(r.id);
      run(() => lookupRequestLocation(form, r));
    };
    if (!requestLocations.has(r.id) && !attemptedRequestLookups.has(r.id)) {
      attemptedRequestLookups.add(r.id);
      await lookupRequestLocation(form, r);
    }
    if (version !== generation) return;
  }
}

document.addEventListener('visibilitychange', () => {
  if (user) expireLocalLocations();
});
