const $ = (id) => document.getElementById(id); let token = sessionStorage.getItem('adm') || ''; $('tok').value = token;
const api = async (m, p, b) => { const r = await fetch('/admin/api' + p, { method: m, headers: { 'x-admin-token': token, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let mode = 'reports';
function row(u) {
  return `<div class="card"><div class="ph">${(u.photos || []).map((p) => `<img src="${esc(p)}" alt="">`).join('') || '<i>no photos</i>'}</div>
  <div class="info"><b>${esc(u.name || '(no name)')}</b>${u.age ? ', ' + u.age : ''} ${u.banned ? '<span class="tag ban">BANNED</span>' : ''}<br><small>${esc(u.email)} · ${esc(u.id)}</small><p>${esc(u.bio)}</p>
  ${u.reports ? `<div>${u.reports} report(s): ${(u.reasons || []).map((r) => `<span class="tag">${esc(r.reason)} x${r.n}</span>`).join('')}</div>` : ''}
  ${u.banReason ? `<small>Ban reason: ${esc(u.banReason)}</small>` : ''}</div>
  <div style="display:flex;flex-direction:column;gap:6px">${u.banned ? `<button data-a="unban" data-id="${esc(u.id)}" class="g">Unban</button>` : `<button data-a="ban" data-id="${esc(u.id)}" class="r">Ban</button>`}
  <button data-a="photos" data-id="${esc(u.id)}" class="g">Remove photos</button>${u.reports ? `<button data-a="dismiss" data-id="${esc(u.id)}" class="g">Dismiss reports</button>` : ''}</div></div>`;
}
async function load() {
  try {
    const j = mode === 'reports' ? await api('GET', '/reports') : await api('GET', '/users?q=' + encodeURIComponent($('q').value));
    $('stat').textContent = mode === 'reports' ? `${j.people.length} reported people · ${j.totalUsers} users · ${j.banned} banned` : `${j.people.length} found`;
    $('list').innerHTML = j.people.map(row).join('') || '<p>Nothing here.</p>';
  } catch (e) { $('stat').textContent = 'Error: ' + e.message; $('list').innerHTML = ''; }
}
$('go').onclick = () => { token = $('tok').value.trim(); sessionStorage.setItem('adm', token); mode = 'reports'; load(); };
$('rep').onclick = () => { mode = 'reports'; load(); }; $('find').onclick = () => { mode = 'users'; load(); };
$('list').onclick = async (e) => {
  const b = e.target.closest('button'); if (!b) return; const id = b.dataset.id, a = b.dataset.a;
  try {
    if (a === 'ban') { const reason = prompt('Reason (kept for your records):', 'Violated community guidelines'); if (reason === null) return; await api('POST', `/users/${id}/ban`, { reason }); }
    else if (a === 'unban') await api('POST', `/users/${id}/unban`);
    else if (a === 'photos') { if (!confirm('Remove all photos of this person?')) return; await api('POST', `/users/${id}/clear-photos`); }
    else if (a === 'dismiss') await api('POST', `/reports/${id}/dismiss`);
    load();
  } catch (err) { alert(err.message); }
};
if (token) load();
