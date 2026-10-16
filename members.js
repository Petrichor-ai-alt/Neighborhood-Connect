'use strict';
let members = [],
  membersEnabled = false,
  memberEditorId = null;
const memberPhotoUrls = new Map(),
  householdLoginRoles = new Map();
function canManageHousehold() {
  return (
    !!membership &&
    !memberDataLoading &&
    (!membersEnabled || membership.household_role === 'manager')
  );
}
function canEditMember(p) {
  return (
    !!p &&
    p.household_id === membership?.household_id &&
    (p.user_id === user?.id || (!p.user_id && canManageHousehold()))
  );
}
async function loadHouseholdMembers(version) {
  const result = await db
    .from('household_members')
    .select('*')
    .in(
      'household_id',
      households.map((h) => h.id),
    )
    .order('created_at');
  if (version !== generation) return;
  if (result.error) {
    if (['PGRST205', '42P01'].includes(result.error.code)) {
      members = [];
      membersEnabled = false;
      memberPhotoUrls.clear();
      return;
    }
    throw result.error;
  }
  members = checked(result);
  membersEnabled = true;
  memberPhotoUrls.clear();
  householdLoginRoles.clear();
  const roles = checked(
    await db.rpc('household_login_roles', { household: membership.household_id }),
  );
  if (version !== generation) return;
  roles.forEach((r) => householdLoginRoles.set(r.member_id, r.household_role));
  const queue = members.filter((p) => p.photo_path);
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length && version === generation) {
        const p = queue.shift();
        const signed = await db.storage.from('member-photos').createSignedUrl(p.photo_path, 300);
        if (!signed.error && version === generation)
          memberPhotoUrls.set(p.id, signed.data.signedUrl);
      }
    }),
  );
}
function memberCards(household) {
  const people = members.filter((p) => p.household_id === household);
  return people.length
    ? people
        .map(
          (p) =>
            `<button class="member-card" data-person="${p.id}">${memberPhotoUrls.has(p.id) ? `<img src="${esc(memberPhotoUrls.get(p.id))}" alt="" loading="lazy">` : `<span class="member-avatar" aria-hidden="true">${esc(initials(p))}</span>`}<span><strong>${esc(p.display_name)}</strong><small>${esc(p.interests || 'View personal profile')}</small></span><span aria-hidden="true">→</span></button>`,
        )
        .join('')
    : '<p>No individual profiles have been added yet.</p>';
}
function wireMemberCards(host) {
  host
    .querySelectorAll('[data-person]')
    .forEach((b) => (b.onclick = () => showMemberDetail(b.dataset.person)));
}
function showMemberDetail(id) {
  const p = members.find((p) => p.id === id);
  if (!p || !membership) return;
  const h = households.find((h) => h.id === p.household_id);
  if (!$('profile').hidden || !$('person').hidden) view('browse');
  $('detail').innerHTML =
    `<button id="back-household" class="text-link">← ${esc(h.display_name)}</button><div class="person-heading">${memberPhotoUrls.has(id) ? `<img class="person-photo" src="${esc(memberPhotoUrls.get(id))}" alt="${esc(p.display_name)}">` : `<span class="member-avatar large" aria-hidden="true">${esc(initials(p))}</span>`}<div><h2>${esc(p.display_name)}</h2><p>Member of ${esc(h.display_name)}</p></div></div>${p.bio ? `<p class="member-bio">${esc(p.bio)}</p>` : ''}${p.interests ? `<p><strong>Interests:</strong> ${esc(p.interests)}</p>` : ''}${p.email ? `<p><strong>Email:</strong> ${esc(p.email)}</p>` : ''}${p.phone ? `<p><strong>Phone:</strong> ${esc(p.phone)}</p>` : ''}${canEditMember(p) ? '<button id="edit-person" class="primary">Edit personal profile</button>' : ''} <button id="close-person">Close</button>`;
  show('detail', true);
  $('back-household').onclick = () => run(() => detail(h.id));
  $('close-person').onclick = () => show('detail', false);
  if ($('edit-person'))
    $('edit-person').onclick = () => {
      view('person');
      openMemberEditor(p.id);
    };
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderMemberManagement() {
  show('household-members', membersEnabled);
  if (!membersEnabled) return;
  show('add-member', canManageHousehold());
  show('member-invite-output', false);
  $('member-invite-output').replaceChildren();
  const people = members.filter((p) => p.household_id === membership.household_id);
  $('my-members').innerHTML = people
    .map(
      (p) =>
        `<article class="member-management">${memberCardsForOne(p)}<div class="member-actions">${canEditMember(p) ? `<button data-edit-person="${p.id}">Edit profile</button>` : ''}${canManageHousehold() && !p.user_id ? `<button data-invite-person="${p.id}">Give own login</button><button data-member-action="cancel_invite" data-id="${p.id}">Cancel invitation</button><button data-member-action="delete" data-id="${p.id}" class="textbutton">Delete profile</button>` : ''}${canManageHousehold() && p.user_id ? `<button data-member-action="${householdLoginRoles.get(p.id) === 'manager' ? 'demote' : 'promote'}" data-id="${p.id}">${householdLoginRoles.get(p.id) === 'manager' ? 'Make member' : 'Make manager'}</button>${p.user_id !== user.id ? `<button data-member-action="remove_login" data-id="${p.id}">Remove login access</button>` : ''}` : ''}</div><small class="member-login">${p.user_id ? (householdLoginRoles.get(p.id) === 'manager' ? 'Household manager · Own login' : 'Own login') : 'Managed through the household account · No login required'}</small></article>`,
    )
    .join('');
  wireMemberCards($('my-members'));
  $('my-members')
    .querySelectorAll('[data-edit-person]')
    .forEach(
      (b) =>
        (b.onclick = () => {
          view('person');
          openMemberEditor(b.dataset.editPerson);
        }),
    );
  $('my-members')
    .querySelectorAll('[data-invite-person]')
    .forEach((b) => (b.onclick = () => showMemberInvite(b.dataset.invitePerson)));
  $('my-members')
    .querySelectorAll('[data-member-action]')
    .forEach(
      (b) =>
        (b.onclick = () =>
          run(async () => {
            const action = b.dataset.memberAction,
              p = members.find((p) => p.id === b.dataset.id);
            const messages = {
              delete: `Delete ${p.display_name}'s individual profile?`,
              remove_login: `Remove ${p.display_name}'s access to this neighborhood? Their profile will remain.`,
              promote: `Allow ${p.display_name} to manage household details and members?`,
              demote: `Change ${p.display_name} to a household member?`,
              cancel_invite: `Cancel any outstanding invitation for ${p.display_name}?`,
            };
            if (!confirm(messages[action])) return;
            if (action === 'delete' && p.photo_path)
              checked(await db.storage.from('member-photos').remove([p.photo_path]));
            checked(await db.rpc('manage_household_member', { person: p.id, action }));
            await load();
            view('profile');
            notice('Household member updated.');
          })),
    );
}
function memberCardsForOne(p) {
  return `<button class="member-card" data-person="${p.id}">${memberPhotoUrls.has(p.id) ? `<img src="${esc(memberPhotoUrls.get(p.id))}" alt="">` : `<span class="member-avatar" aria-hidden="true">${esc(initials(p))}</span>`}<span><strong>${esc(p.display_name)}</strong><small>View profile</small></span><span aria-hidden="true">→</span></button>`;
}
function openMemberEditor(id) {
  if (!membersEnabled) return;
  const p = id ? members.find((p) => p.id === id) : null;
  if ((id && !canEditMember(p)) || (!id && !canManageHousehold())) {
    $('person-editor').innerHTML =
      '<p>Your personal profile is not linked yet. Ask your household manager for an invitation.</p>';
    return;
  }
  memberEditorId = p?.id || null;
  $('page-title').textContent =
    p?.user_id === user.id
      ? 'Your personal profile'
      : p
        ? `Edit ${p.display_name}`
        : 'Add a household member';
  $('person-editor').innerHTML =
    `<div class="module-heading"><h2>${p ? 'Personal details' : 'A new member of your household'}</h2><button id="person-back" class="text-link">Back to household</button></div><p>Approved neighbors can see these details. Contact information and photos are optional. Manage your own contact visibility in Account Settings.</p><form id="memberform"><label>Name<input name="display_name" required maxlength="100" value="${esc(p?.display_name || '')}"></label><label>About this person<textarea name="bio" maxlength="1500" rows="4">${esc(p?.bio || '')}</textarea></label><label>Interests<input name="interests" maxlength="500" value="${esc(p?.interests || '')}" placeholder="Gardening, books, hiking…"></label><label>Contact email (optional)<input name="email" type="email" maxlength="200" value="${esc(p?.email || '')}"></label><label>Phone (optional)<input name="phone" type="tel" maxlength="40" value="${esc(p?.phone || '')}"></label><button class="primary">Save member profile</button></form>${p ? `<hr><h3>Profile photo</h3>${memberPhotoUrls.has(p.id) ? `<img class="person-photo" src="${esc(memberPhotoUrls.get(p.id))}" alt="Your member profile photo"><button id="remove-person-photo">Remove photo</button>` : ''}<label>Add or replace photo<input id="person-upload" type="file" accept="image/jpeg,image/png,image/webp"></label>` : '<p class="member-note">Save this profile first to add a photo or an optional separate login.</p>'}`;
  $('person-back').onclick = () => view('profile');
  $('memberform').onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const form = e.target,
        button = form.querySelector('button');
      button.disabled = true;
      const version = generation;
      try {
        const data = Object.fromEntries(new FormData(form));
        const newId = checked(
          await db.rpc('save_household_member', {
            household: membership.household_id,
            person: memberEditorId,
            person_name: data.display_name,
            person_bio: data.bio,
            person_interests: data.interests,
            contact_email: data.email,
            contact_phone: data.phone,
            photo: p?.photo_path || '',
          }),
        );
        if (version !== generation) return;
        await load();
        view('person');
        openMemberEditor(newId);
        notice('Member profile saved.');
      } finally {
        button.disabled = false;
      }
    });
  };
  if (p) {
    $('person-upload').onchange = () => run(() => uploadMemberPhoto(p));
    if ($('remove-person-photo'))
      $('remove-person-photo').onclick = () =>
        run(async () => {
          await saveMemberPhoto(p, '');
          checked(await db.storage.from('member-photos').remove([p.photo_path]));
          await load();
          view('person');
          openMemberEditor(p.id);
          notice('Profile photo removed.');
        });
  }
}
async function saveMemberPhoto(p, path) {
  const form = $('memberform');
  if (form) {
    const values = Object.fromEntries(new FormData(form));
    p = {
      ...p,
      display_name: values.display_name,
      bio: values.bio,
      interests: values.interests,
      email: values.email,
      phone: values.phone,
    };
  }
  return checked(
    await db.rpc('save_household_member', {
      household: p.household_id,
      person: p.id,
      person_name: p.display_name,
      person_bio: p.bio,
      person_interests: p.interests,
      contact_email: p.email,
      contact_phone: p.phone,
      photo: path,
    }),
  );
}
async function uploadMemberPhoto(p) {
  const input = $('person-upload'),
    file = input.files[0];
  if (!file) return;
  if (!$('memberform').reportValidity()) return;
  input.disabled = true;
  const version = generation;
  try {
    const blob = await compress(file);
    if (version !== generation) return;
    const path = `${p.id}/${Date.now()}-${crypto.randomUUID()}.jpg`;
    checked(
      await db.storage
        .from('member-photos')
        .upload(path, blob, { contentType: 'image/jpeg', upsert: false }),
    );
    try {
      await saveMemberPhoto(p, path);
    } catch (e) {
      await db.storage.from('member-photos').remove([path]);
      throw e;
    }
    if (p.photo_path) await db.storage.from('member-photos').remove([p.photo_path]);
    if (version !== generation) return;
    await load();
    view('person');
    openMemberEditor(p.id);
    notice('Member photo uploaded privately.');
  } finally {
    input.disabled = false;
    input.value = '';
  }
}
function showMemberInvite(id) {
  const p = members.find((p) => p.id === id);
  if (!p || p.user_id || !canManageHousehold()) return;
  const host = $('member-invite-output');
  host.innerHTML = `<h3>A separate login for ${esc(p.display_name)}</h3><p>Enter the email they will use to sign in. This links their existing profile and keeps the household together.</p><form id="memberinviteform"><label>Login email<input name="email" type="email" required maxlength="200" value="${esc(p.email)}"></label><button class="primary">Create invitation</button></form><div id="invitation-result"></div>`;
  show('member-invite-output', true);
  $('memberinviteform').onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const button = e.target.querySelector('button'),
        version = generation;
      button.disabled = true;
      try {
        const email = new FormData(e.target).get('email');
        const code = checked(
          await db.rpc('invite_household_member', { person: p.id, login_email: email }),
        );
        if (version !== generation) return;
        const link = new URL(cfg.authRedirectUrl);
        link.hash = `invite=${code}`;
        $('invitation-result').innerHTML =
          `<p>Send this link to <strong>${esc(email)}</strong> yourself. It expires in 7 days. Creating another invitation replaces this one.</p><label>Invitation link<input id="invitation-link" readonly value="${esc(link.href)}"></label><label>Invitation code<input readonly value="${esc(code)}"></label><button id="copy-invitation" type="button">Copy link</button><p>They can sign in or create an account, verify their email, then accept this invitation. No email has been sent by this website.</p>`;
        $('copy-invitation').onclick = () =>
          run(async () => {
            await navigator.clipboard.writeText(link.href);
            notice('Invitation link copied.');
          });
      } finally {
        button.disabled = false;
      }
    });
  };
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
let invitationCode = '';
function rememberInvite(code) {
  invitationCode = code;
  try {
    if (code) sessionStorage.setItem('nc-household-invite', code);
    else sessionStorage.removeItem('nc-household-invite');
  } catch (e) {
    /* Private browsing may disable storage. */
  }
}
function syncInvitePanel() {
  show('invite-panel', !!invitationCode);
  if (invitationCode) $('invite-code').value = invitationCode;
}
function initMembersUI() {
  try {
    invitationCode = sessionStorage.getItem('nc-household-invite') || '';
  } catch (e) {
    /* Optional storage. */
  }
  const hash = new URLSearchParams(location.hash.slice(1)),
    code = hash.get('invite');
  if (code && /^[a-f0-9]{64}$/.test(code)) {
    rememberInvite(code);
    history.replaceState(null, '', location.pathname + location.search);
  }
  $('add-member').onclick = () => {
    view('person');
    openMemberEditor(null);
  };
  $('dismiss-invite').onclick = () => {
    rememberInvite('');
    syncInvitePanel();
  };
  $('inviteform').onsubmit = (e) => {
    e.preventDefault();
    run(async () => {
      if (!user) throw new Error('Sign in or create an account first, using the invited email.');
      const code = new FormData(e.target).get('code').trim();
      rememberInvite(code);
      checked(await db.rpc('accept_household_invite', { invite_code: code }));
      rememberInvite('');
      syncInvitePanel();
      await load();
      notice('You are now linked to your household. Your existing member profile is ready.');
    });
  };
}
