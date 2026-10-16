'use strict';
const discussionCategories = {
  general: 'General',
  recommendations: 'Recommendations',
  questions: 'Questions',
  ideas: 'Neighborhood ideas',
};
let discussionRequest = 0,
  discussionThread = null,
  discussionReplies = [],
  discussionEditing = null,
  discussionSaving = false,
  discussionPage = 0,
  discussionReplyPage = 0,
  discussionNoticeTimer;
const discussionPageSize = 20;
function discussionCurrent(version, request, area) {
  return (
    version === generation &&
    request === discussionRequest &&
    !!user &&
    !!membership &&
    neighborhood?.id === area &&
    !$('discussions').hidden
  );
}
function resetDiscussions() {
  ++discussionRequest;
  clearTimeout(discussionNoticeTimer);
  discussionThread = null;
  discussionReplies = [];
  discussionEditing = null;
  discussionSaving = false;
  $('discussion-editor').close?.();
  $('discussion-form').reset?.();
  [...$('discussion-form').elements].forEach((el) => {
    if (el.name) el.value = '';
  });
  $('discussion-list').replaceChildren();
  $('discussion-content').replaceChildren();
  $('discussion-replies').replaceChildren();
  $('discussion-error').textContent = '';
  $('discussion-form-error').textContent = '';
  $('discussion-confirmation').textContent = '';
  show('discussion-confirmation', false);
}
function discussionDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: neighborhood?.time_zone || 'America/Chicago',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}
function discussionError(error) {
  return ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error.code)
    ? 'Discussions are being set up. Please check back soon.'
    : error.message || 'Discussions could not load. Please try again.';
}
function discussionConfirm(message) {
  clearTimeout(discussionNoticeTimer);
  $('discussion-confirmation').textContent = message;
  show('discussion-confirmation', true);
  discussionNoticeTimer = setTimeout(() => show('discussion-confirmation', false), 4000);
}
async function openDiscussions() {
  if (!membership || !user) return;
  $('discussion-category').value ||= 'all';
  await loadDiscussionList();
}
async function loadDiscussionList(more = false) {
  if (!membership || !user) return;
  const version = generation,
    area = neighborhood.id,
    request = ++discussionRequest;
  discussionThread = null;
  show('discussion-list-view', true);
  show('discussion-detail-view', false);
  show('discussion-filter', true);
  $('discussion-error').textContent = '';
  $('discussion-status').textContent = 'Loading discussions…';
  $('discussion-more').disabled = true;
  if (!more) {
    discussionPage = 0;
    $('discussion-list').replaceChildren();
  }
  const page = more ? discussionPage + 1 : 0;
  try {
    let query = db
      .from('discussion_threads')
      .select(
        'id,title,category,status,author_name,author_user_id,created_at,last_activity,reply_count,revision',
      )
      .eq('neighborhood_id', area)
      .order('last_activity', { ascending: false })
      .order('id');
    const category = $('discussion-category').value;
    if (category !== 'all') query = query.eq('category', category);
    const rows = checked(
      await query.range(page * discussionPageSize, (page + 1) * discussionPageSize),
    );
    if (!discussionCurrent(version, request, area)) return;
    discussionPage = page;
    for (const row of rows.slice(0, discussionPageSize)) {
      if ([...$('discussion-list').children].some((el) => el.dataset.thread === row.id)) continue;
      const button = document.createElement('button');
      button.className = 'discussion-row';
      button.dataset.thread = row.id;
      button.innerHTML = `<span class="discussion-row-copy"><span class="discussion-category-tag">${esc(discussionCategories[row.category] || 'General')}${row.status === 'closed' ? ' · Closed' : ''}</span><strong>${esc(row.title)}</strong><small>${esc(row.author_name)} · ${esc(discussionDate(row.last_activity))}</small></span><span class="discussion-reply-count">${row.reply_count} ${row.reply_count === 1 ? 'reply' : 'replies'} <span aria-hidden="true">→</span></span>`;
      button.onclick = () => run(() => openDiscussionThread(row.id));
      $('discussion-list').append(button);
    }
    show('discussion-more', rows.length > discussionPageSize);
    $('discussion-status').textContent = $('discussion-list').children.length
      ? 'Latest activity first. Shared only with approved neighbors.'
      : 'No discussions here yet. Start a conversation with your neighbors.';
  } catch (error) {
    if (discussionCurrent(version, request, area)) {
      $('discussion-error').textContent = discussionError(error);
      $('discussion-status').textContent = '';
    }
  } finally {
    if (discussionCurrent(version, request, area)) $('discussion-more').disabled = false;
  }
}
function discussionAction(host, label, action, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (danger) button.className = 'discussion-remove';
  button.onclick = async () => {
    if (button.disabled) return;
    button.disabled = true;
    const version = generation,
      request = discussionRequest,
      area = neighborhood?.id;
    try {
      await action();
    } catch (error) {
      if (discussionCurrent(version, request, area))
        $('discussion-error').textContent = discussionError(error);
    } finally {
      button.disabled = false;
    }
  };
  host.append(button);
}
async function openDiscussionThread(id, more = false) {
  if (!membership || !user) return;
  const version = generation,
    area = neighborhood.id,
    request = ++discussionRequest;
  $('discussion-error').textContent = '';
  $('discussion-status').textContent = 'Loading conversation…';
  show('discussion-list-view', false);
  show('discussion-detail-view', true);
  show('discussion-filter', false);
  $('discussion-replies-more').disabled = true;
  if (!more) {
    discussionThread = null;
    discussionReplies = [];
    discussionReplyPage = 0;
    $('discussion-content').replaceChildren();
    $('discussion-replies').replaceChildren();
    $('discussion-actions').replaceChildren();
    show('discussion-add-reply', false);
  }
  const page = more ? discussionReplyPage + 1 : 0;
  try {
    const results = await Promise.allSettled([
      db
        .from('discussion_threads')
        .select('*')
        .eq('id', id)
        .eq('neighborhood_id', area)
        .maybeSingle(),
      db
        .from('discussion_replies')
        .select('*')
        .eq('thread_id', id)
        .order('created_at')
        .order('id')
        .range(page * 30, (page + 1) * 30),
    ]);
    const values = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return checked(result.value);
    });
    if (!discussionCurrent(version, request, area)) return;
    const [row, replies] = values;
    if (!row)
      throw Error('This discussion is no longer available. Return to discussions to refresh.');
    discussionThread = row;
    discussionReplyPage = page;
    const known = new Set(discussionReplies.map((reply) => reply.id));
    discussionReplies.push(...replies.slice(0, 30).filter((reply) => !known.has(reply.id)));
    $('discussion-content').innerHTML =
      `<span class="discussion-category-tag">${esc(discussionCategories[row.category])}${row.status === 'closed' ? ' · Closed' : ''}</span><h2>${esc(row.title)}</h2><p class="discussion-meta">${esc(row.author_name)} · ${esc(discussionDate(row.created_at))}${row.revision > 1 ? ' · Updated' : ''}</p><p class="discussion-body">${esc(row.body)}</p>`;
    const actions = $('discussion-actions');
    actions.replaceChildren();
    if (row.author_user_id === user.id && row.status === 'open')
      discussionAction(actions, 'Edit discussion', () => openDiscussionEditor('thread', row));
    if (membership.role === 'admin')
      discussionAction(
        actions,
        row.status === 'closed' ? 'Reopen discussion' : 'Close discussion',
        async () => {
          const action = row.status === 'closed' ? 'reopen' : 'close';
          if (
            !confirm(
              `${action === 'close' ? 'Close' : 'Reopen'} this discussion? ${action === 'close' ? 'Neighbors will still be able to read it.' : 'Neighbors will be able to reply again.'}`,
            )
          )
            return;
          checked(
            await db.rpc('moderate_discussion', {
              thread: row.id,
              action,
              expected_revision: row.revision,
            }),
          );
          if (!discussionCurrent(version, request, area)) return;
          await openDiscussionThread(row.id);
          discussionConfirm(action === 'close' ? 'Discussion closed.' : 'Discussion reopened.');
        },
      );
    if (row.author_user_id === user.id || membership.role === 'admin')
      discussionAction(
        actions,
        'Remove discussion',
        async () => {
          if (!confirm('Remove this discussion and all its replies? This cannot be undone.'))
            return;
          checked(
            await db.rpc('moderate_discussion', {
              thread: row.id,
              action: 'remove',
              expected_revision: row.revision,
            }),
          );
          if (!discussionCurrent(version, request, area)) return;
          await loadDiscussionList();
          discussionConfirm('Discussion removed.');
        },
        true,
      );
    renderDiscussionReplies();
    show('discussion-replies-more', replies.length > 30);
    show('discussion-add-reply', row.status === 'open');
    $('discussion-status').textContent =
      row.status === 'closed'
        ? 'This discussion is closed. You can still read the conversation.'
        : `${row.reply_count} ${row.reply_count === 1 ? 'reply' : 'replies'} · Join the conversation below.`;
  } catch (error) {
    if (discussionCurrent(version, request, area)) {
      $('discussion-error').textContent = discussionError(error);
      $('discussion-status').textContent = '';
    }
  } finally {
    if (discussionCurrent(version, request, area)) $('discussion-replies-more').disabled = false;
  }
}
function renderDiscussionReplies() {
  $('discussion-replies').replaceChildren();
  for (const reply of discussionReplies) {
    const article = document.createElement('article');
    article.className = 'discussion-reply';
    article.innerHTML = `<p class="discussion-meta"><strong>${esc(reply.author_name)}</strong> · ${esc(discussionDate(reply.created_at))}${reply.revision > 1 ? ' · Edited' : ''}</p><p class="discussion-body">${esc(reply.body)}</p><div class="discussion-post-actions"></div>`;
    const actions = article.querySelector('.discussion-post-actions');
    if (reply.author_user_id === user.id && discussionThread.status === 'open')
      discussionAction(actions, 'Edit', () => openDiscussionEditor('reply', reply));
    if (reply.author_user_id === user.id || membership.role === 'admin')
      discussionAction(
        actions,
        'Remove',
        async () => {
          if (!confirm('Remove this reply? This cannot be undone.')) return;
          const version = generation,
            area = neighborhood.id,
            request = discussionRequest,
            thread = discussionThread.id;
          checked(
            await db.rpc('remove_discussion_reply', {
              reply: reply.id,
              expected_revision: reply.revision,
            }),
          );
          if (!discussionCurrent(version, request, area)) return;
          await openDiscussionThread(thread);
          discussionConfirm('Reply removed.');
        },
        true,
      );
    $('discussion-replies').append(article);
  }
}
function openDiscussionEditor(kind, row = null) {
  if (!membership || !user || $('discussions').hidden || discussionSaving) return;
  if (row && row.author_user_id !== user.id) return;
  if (kind === 'reply' && (!discussionThread || discussionThread.status !== 'open')) return;
  discussionEditing = { kind, row, thread: discussionThread?.id || null };
  const form = $('discussion-form');
  form.elements.title.value = row?.title || '';
  form.elements.body.value = row?.body || '';
  form.elements.category.value = row?.category || 'general';
  form.elements.title.disabled = kind !== 'thread';
  form.elements.title.required = kind === 'thread';
  form.elements.category.disabled = kind !== 'thread';
  form.elements.body.maxLength = kind === 'thread' ? 5000 : 3000;
  show('discussion-title-field', kind === 'thread');
  show('discussion-category-field', kind === 'thread');
  $('discussion-editor-title').textContent = row
    ? `Edit ${kind === 'thread' ? 'discussion' : 'reply'}`
    : kind === 'thread'
      ? 'Start a discussion'
      : 'Write a reply';
  $('discussion-save').textContent = row
    ? 'Save changes'
    : kind === 'thread'
      ? 'Post discussion'
      : 'Post reply';
  $('discussion-form-error').textContent = '';
  $('discussion-save').disabled = false;
  $('discussion-editor').showModal();
  (kind === 'thread' ? form.elements.title : form.elements.body).focus();
}
function closeDiscussionEditor(force = false) {
  if (discussionSaving && !force) return;
  $('discussion-editor').close();
  discussionEditing = null;
  [...$('discussion-form').elements].forEach((el) => {
    if (el.name) el.value = '';
  });
  $('discussion-form-error').textContent = '';
}
function initDiscussions() {
  $('discussion-new').onclick = () => openDiscussionEditor('thread');
  $('discussion-add-reply').onclick = () => openDiscussionEditor('reply');
  $('discussion-back').onclick = () => run(() => loadDiscussionList());
  $('discussion-refresh').onclick = () =>
    run(() =>
      discussionThread ? openDiscussionThread(discussionThread.id) : loadDiscussionList(),
    );
  $('discussion-category').onchange = () => run(() => loadDiscussionList());
  $('discussion-more').onclick = () => run(() => loadDiscussionList(true));
  $('discussion-replies-more').onclick = () =>
    run(() => openDiscussionThread(discussionThread.id, true));
  $('discussion-editor-close').onclick = () => closeDiscussionEditor();
  $('discussion-cancel').onclick = () => closeDiscussionEditor();
  $('discussion-editor').oncancel = (event) => {
    event.preventDefault();
    closeDiscussionEditor();
  };
  $('discussion-editor').onclick = (event) => {
    if (event.target !== $('discussion-editor')) return;
    const bounds = event.target.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      closeDiscussionEditor();
  };
  $('discussion-form').onsubmit = async (event) => {
    event.preventDefault();
    if (discussionSaving || !discussionEditing || !membership || !user) return;
    const form = event.target;
    if (!form.reportValidity()) return;
    if (
      !form.elements.body.value.trim() ||
      (discussionEditing.kind === 'thread' && !form.elements.title.value.trim())
    ) {
      $('discussion-form-error').textContent = 'Add a title and message before posting.';
      return;
    }
    const edit = discussionEditing,
      version = generation,
      area = neighborhood.id,
      request = discussionRequest;
    discussionSaving = true;
    $('discussion-save').disabled = true;
    $('discussion-form-error').textContent = '';
    try {
      const id = checked(
        await db.rpc(
          edit.kind === 'thread' ? 'save_discussion_thread' : 'save_discussion_reply',
          edit.kind === 'thread'
            ? {
                neighborhood: area,
                thread: edit.row?.id || null,
                thread_title: form.elements.title.value.trim(),
                thread_body: form.elements.body.value.trim(),
                thread_category: form.elements.category.value,
                expected_revision: edit.row?.revision || null,
              }
            : {
                thread: edit.thread,
                reply: edit.row?.id || null,
                reply_body: form.elements.body.value.trim(),
                expected_revision: edit.row?.revision || null,
              },
        ),
      );
      if (!discussionCurrent(version, request, area)) return;
      closeDiscussionEditor(true);
      await openDiscussionThread(edit.kind === 'thread' ? id : edit.thread);
      discussionConfirm(
        edit.row
          ? 'Changes saved.'
          : edit.kind === 'thread'
            ? 'Discussion posted.'
            : 'Reply posted.',
      );
    } catch (error) {
      if (discussionCurrent(version, request, area))
        $('discussion-form-error').textContent = discussionError(error);
    } finally {
      if (version === generation) {
        discussionSaving = false;
        $('discussion-save').disabled = false;
      }
    }
  };
}
