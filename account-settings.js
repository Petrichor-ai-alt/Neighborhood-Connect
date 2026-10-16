'use strict';
let accountSettingsReady = false;
function showAccountSettingsPage(page = 'menu', focus = true) {
  if (!['menu', 'email', 'password', 'contacts', 'sessions', 'delete'].includes(page)) return;
  document.querySelectorAll('[data-account-settings-page]').forEach((section) => {
    section.hidden = section.dataset.accountSettingsPage !== page;
  });
  show('settings-menu', page === 'menu');
  show('settings-detail', page !== 'menu');
  document.querySelectorAll('#settings input[type="password"]').forEach((input) => {
    input.value = '';
  });
  $('account-delete-form').elements.confirmation.value = '';
  if (focus) {
    const target =
      page === 'menu'
        ? document.querySelector('[data-account-page]')
        : $(`account-${page}-heading`);
    target?.focus();
  }
}
function clearAccountSettings() {
  accountSettingsReady = false;
  showAccountSettingsPage('menu', false);
  [
    'account-email-form',
    'account-password-form',
    'account-contacts-form',
    'account-delete-form',
  ].forEach((id) => {
    const form = $(id);
    [...form.elements].forEach((el) => {
      if (el.name) {
        el.value = '';
        if (el.type === 'checkbox') el.checked = false;
      }
    });
  });
  [
    'settings-name',
    'settings-email',
    'settings-verified',
    'settings-neighborhood',
    'settings-household',
    'settings-role',
    'settings-pending-email',
  ].forEach((id) => ($(id).textContent = ''));
  show('account-contacts-form', false);
  show('account-delete-form', false);
}
async function renderAccountSettings(page = 'menu') {
  if (!user) return;
  const version = generation,
    identity = user.id;
  clearAccountSettings();
  showAccountSettingsPage(page, false);
  const fresh = checked(await db.auth.getUser()).user;
  if (version !== generation || identity !== user?.id || $('settings').hidden) return;
  user = fresh;
  const person = members.find(
    (p) => p.user_id === user.id && p.household_id === membership?.household_id,
  );
  const household = households.find((h) => h.id === membership?.household_id);
  $('settings-name').textContent =
    person?.display_name || user.user_metadata?.full_name || 'Your account';
  $('settings-email').textContent = user.email || 'No sign-in email';
  $('settings-verified').textContent = user.email_confirmed_at ? 'Verified' : 'Not yet verified';
  $('settings-neighborhood').textContent = neighborhood?.name || neighborhoodName;
  $('settings-household').textContent = household?.display_name || 'Not yet linked to a household';
  $('settings-role').textContent = membership
    ? `${membership.role === 'admin' ? 'Neighborhood administrator' : 'Resident'} · ${membership.household_role === 'manager' ? 'Household manager' : 'Household member'}`
    : 'Awaiting resident access';
  show('settings-pending-email', !!user.new_email);
  if (user.new_email)
    $('settings-pending-email').textContent = `Pending confirmation: ${user.new_email}`;
  $('account-contacts-status').textContent = 'Loading your contact settings…';
  $('account-delete-status').textContent = 'Loading account deletion options…';
  const result = await db.rpc('account_settings', { neighborhood_slug: cfg.neighborhoodSlug });
  if (version !== generation || identity !== user?.id || $('settings').hidden) return;
  if (result.error) {
    if (['PGRST202', '42883'].includes(result.error.code)) {
      $('account-contacts-status').textContent =
        'Contact information will be available after the account settings database update.';
      $('account-delete-status').textContent =
        'Account deletion will be available after the account settings database update.';
      return;
    }
    throw result.error;
  }
  const settings = checked(result);
  accountSettingsReady = true;
  if (settings.contact) {
    const form = $('account-contacts-form');
    form.elements.contact_email.value = settings.contact.email;
    form.elements.contact_phone.value = settings.contact.phone;
    form.elements.share_email.checked = settings.contact.share_email;
    form.elements.share_phone.checked = settings.contact.share_phone;
    show('account-contacts-form', true);
    $('account-contacts-status').textContent =
      'Hidden contact details stay private to your account.';
  } else
    $('account-contacts-status').textContent =
      'Contact information become available when your individual profile is linked to your account.';
  $('account-delete-status').textContent =
    settings.deletion_blocker ||
    'You can delete your account after confirming your password below.';
  show('account-delete-form', !settings.deletion_blocker);
}
async function verifyAccountPassword(password) {
  const identity = user?.id;
  if (!identity) throw Error('Sign in first.');
  const fresh = checked(await db.auth.getUser()).user;
  if (fresh?.id !== identity || !fresh.email) throw Error('Your session changed. Sign in again.');
  const result = checked(await db.auth.signInWithPassword({ email: fresh.email, password }));
  if (result.user?.id !== identity) throw Error('Your session changed. Sign in again.');
}
function accountForm(id, action) {
  $(id).onsubmit = (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    const form = e.target,
      button = form.querySelector('button');
    if (button.disabled) return;
    run(async () => {
      button.disabled = true;
      try {
        await action(Object.fromEntries(new FormData(form)), form);
      } finally {
        [...form.elements].filter((el) => el.type === 'password').forEach((el) => (el.value = ''));
        button.disabled = false;
      }
    });
  };
}
async function accountSignOut(scope) {
  checked(await db.auth.signOut({ scope }));
  show('recovery', false);
  await load();
  notice(
    scope === 'global'
      ? 'Signed out of all devices. Other sessions end when their access tokens expire.'
      : 'Signed out on this device.',
  );
}
function initAccountSettings() {
  document.querySelectorAll('[data-account-page]').forEach((link) => {
    link.onclick = (event) => {
      event.preventDefault();
      if (user) showAccountSettingsPage(link.dataset.accountPage);
    };
  });
  $('settings-menu-back').onclick = () => showAccountSettingsPage();
  $('settings-back').onclick = () => (membership ? view('overview') : run(load));
  accountForm('account-email-form', async (values, form) => {
    if (values.email.trim().toLowerCase() === user.email.toLowerCase())
      throw Error('Enter a different sign-in email.');
    await verifyAccountPassword(values.current_password);
    checked(
      await db.auth.updateUser(
        { email: values.email.trim() },
        { emailRedirectTo: cfg.authRedirectUrl },
      ),
    );
    form.elements.email.value = '';
    await renderAccountSettings('email');
    notice(
      'Follow the email confirmation instructions to finish changing your sign-in email. Your contact email is unchanged.',
    );
  });
  accountForm('account-password-form', async (values) => {
    if (values.password !== values.confirm_password) throw Error('The new passwords do not match.');
    if (values.password.length < 12) throw Error('Use at least 12 characters.');
    if (values.password === values.current_password) throw Error('Choose a different password.');
    await verifyAccountPassword(values.current_password);
    checked(await db.auth.updateUser({ password: values.password }));
    notice('Password updated. You can also sign out all devices in Signed-in sessions.');
  });
  $('account-reset-password').onclick = () => openPasswordReset('settings');
  accountForm('account-contacts-form', async (values, form) => {
    if (!accountSettingsReady) throw Error('Reload your account settings first.');
    checked(
      await db.rpc('save_account_contacts', {
        neighborhood_slug: cfg.neighborhoodSlug,
        contact_email: values.contact_email,
        contact_phone: values.contact_phone,
        show_email: form.elements.share_email.checked,
        show_phone: form.elements.share_phone.checked,
      }),
    );
    await load();
    view('settings');
    notice('Contact information saved.');
  });
  $('account-signout-local').onclick = () => run(() => accountSignOut('local'));
  $('account-signout-all').onclick = () =>
    run(async () => {
      if (!confirm('Sign out of Neighborhood Connect on all your devices?')) return;
      await accountSignOut('global');
    });
  accountForm('account-delete-form', async (values) => {
    if (!accountSettingsReady || values.confirmation !== 'DELETE')
      throw Error('Type DELETE to confirm.');
    if (
      !confirm(
        'Permanently delete your account, individual profiles and uploaded photos? Your household will remain. This cannot be undone.',
      )
    )
      return;
    const result = await db.functions.invoke('delete-account', {
      body: { password: values.current_password, confirmation: values.confirmation },
    });
    if (result.error) {
      const response = result.error.context;
      let message =
        'Account deletion failed. Check that the delete-account function is deployed, then try again.';
      if (response?.json) {
        const body = await response.json().catch(() => null);
        if (body?.error) message = body.error;
      }
      throw Error(message);
    }
    if (!result.data?.deleted) throw Error('Account deletion was not confirmed.');
    await db.auth.signOut({ scope: 'local' });
    await load();
    notice('Your account has been deleted. Your household remains in the community.');
  });
}
