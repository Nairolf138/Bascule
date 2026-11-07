import { compareDocuments, wordDiff, makeMarkdownReport } from './engine.mjs';
import { EXAMPLE } from './example.mjs';

const $ = (selector) => document.querySelector(selector);
const fields = {
  old: { text: $('#oldText'), name: $('#oldName'), count: $('#oldCount'), file: $('#oldFile'), drop: $('#oldDrop') },
  new: { text: $('#newText'), name: $('#newName'), count: $('#newCount'), file: $('#newFile'), drop: $('#newDrop') },
};
const status = $('#status');
const filters = $('#filters');
const list = $('#changeList');
const search = $('#search');
let result = null;
let activeFilter = 'attention';
let reviews = Object.create(null);
let dirty = false;

const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const plural = (count, one, many = `${one}s`) => `${count.toLocaleString('fr-FR')} ${count === 1 ? one : many}`;

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function updateCounts() {
  for (const item of Object.values(fields)) item.count.textContent = plural(item.text.value.length, 'caractère');
}

function setDocument(side, text, name) {
  fields[side].text.value = text;
  if (name !== undefined) fields[side].name.value = name;
  dirty = true;
  updateCounts();
}

function loadExample() {
  reviews = Object.create(null);
  setDocument('old', EXAMPLE.oldText, EXAMPLE.oldName);
  setDocument('new', EXAMPLE.newText, EXAMPLE.newName);
  search.value = '';
  activeFilter = 'attention';
  analyze();
  setStatus('Exemple chargé. Remplacez les textes ou importez vos propres fichiers.');
}

function analyze() {
  try {
    result = compareDocuments(fields.old.text.value, fields.new.text.value);
    dirty = false;
    $('#results').hidden = false;
    render();
    setStatus('Comparaison terminée. Les documents restent sur cet ordinateur.');
    return true;
  } catch (error) {
    setStatus(error.message || 'Impossible de comparer ces textes.', true);
    return false;
  }
}

function metric(value, label, attention = false) {
  return `<div class="metric${attention ? ' attention' : ''}"><strong>${value}</strong><span>${label}</span></div>`;
}

const filterDefinitions = [
  { id: 'attention', label: 'À relire', count: (r) => r.attention },
  { id: 'all', label: 'Tous les écarts', count: (r) => r.changes.length - r.counts.unchanged },
  { id: 'modified', label: 'Reformulés', count: (r) => r.counts.modified },
  { id: 'added', label: 'Ajoutés', count: (r) => r.counts.added },
  { id: 'removed', label: 'Supprimés', count: (r) => r.counts.removed },
  { id: 'moved', label: 'Déplacés', count: (r) => r.counts.moved },
  { id: 'unchanged', label: 'Inchangés', count: (r) => r.counts.unchanged },
];

function render() {
  if (!result) return;
  $('#summaryBar').innerHTML = metric(result.attention, 'À relire', true)
    + metric(result.counts.modified, 'Reformulés') + metric(result.counts.added, 'Ajoutés')
    + metric(result.counts.removed, 'Supprimés') + metric(result.counts.moved, 'Déplacés');
  const total = result.changes.length - result.counts.unchanged;
  $('#resultStatement').textContent = total
    ? `${plural(total, 'écart')} entre les deux versions, dont ${plural(result.attention, 'passage')} avec un signal de relecture.`
    : 'Aucun écart détecté entre les deux versions.';
  filters.innerHTML = filterDefinitions.map((definition) => `<button type="button" class="filter${activeFilter === definition.id ? ' active' : ''}" data-filter="${definition.id}" aria-pressed="${activeFilter === definition.id}">${definition.label}<span class="filter-count">${definition.count(result)}</span></button>`).join('');
  renderProgress();
  renderList();
}

function renderProgress() {
  if (!result) return;
  const changes = result.changes.filter((change) => change.type !== 'unchanged');
  const verified = changes.filter((change) => reviews[change.id]?.state === 'verified').length;
  const questions = changes.filter((change) => reviews[change.id]?.state === 'question').length;
  const completed = verified + questions;
  $('#reviewProgress').innerHTML = `<div class="progress-label"><strong>Suivi de relecture</strong><span>${completed} / ${changes.length} triés · ${verified} vérifiés · ${questions} questions ouvertes</span></div><progress max="${Math.max(1, changes.length)}" value="${completed}">${completed} sur ${changes.length}</progress>`;
}

function renderParts(parts) {
  return parts.map((part) => part.changed && part.text.trim()
    ? `<mark>${escapeHTML(part.text)}</mark>` : escapeHTML(part.text)).join('');
}

function renderSide(block, side, highlighted = null) {
  const label = side === 'old' ? 'Avant · A' : 'Après · B';
  const line = block ? `<button type="button" class="jump" data-side="${side}" data-line="${block.line}">Ligne ${block.line} ↗</button>` : '';
  const content = block ? (highlighted ? renderParts(highlighted) : escapeHTML(block.text)) : 'Aucun passage';
  return `<div class="passage-side ${side === 'new' ? 'after' : 'before'}"><div class="passage-label"><span>${label}</span>${line}</div><div class="passage-text${block ? '' : ' empty'}">${content}</div></div>`;
}

function renderCard(change, index) {
  const labels = { modified: 'Reformulé', added: 'Ajouté', removed: 'Supprimé', moved: 'Déplacé', unchanged: 'Inchangé' };
  const diff = change.type === 'modified' ? wordDiff(change.oldBlock.text, change.newBlock.text) : null;
  const signals = change.signals.length ? `<div class="signal-row">${change.signals.map((signal) =>
    `<span class="signal ${signal.kind}">${signal.kind === 'number' ? '▣' : '◇'} ${escapeHTML(signal.label)}${signal.kind === 'number' ? `<span class="signal-detail">${escapeHTML(signal.before)} → ${escapeHTML(signal.after)}</span>` : ''}</span>`).join('')}</div>` : '';
  const location = `A : ${change.oldBlock?.line ?? '—'} · B : ${change.newBlock?.line ?? '—'}`;
  const review = reviews[change.id] ?? { state: 'todo', note: '' };
  const reviewButtons = [['todo', 'À faire'], ['verified', 'Vérifié'], ['question', 'Question ouverte']]
    .map(([state, label]) => `<button type="button" class="review-button${review.state === state ? ' selected' : ''}" data-review-state="${state}" aria-pressed="${review.state === state}">${label}</button>`).join('');
  const footer = change.type === 'unchanged' ? '' : `<div class="review-footer"><div class="review-actions"><span class="review-caption">Relecture</span>${reviewButtons}</div><label class="review-note">Note <input type="text" maxlength="500" data-review-note value="${escapeHTML(review.note)}" placeholder="Ajouter une précision…" aria-label="Note de relecture du passage ${index + 1}"></label></div>`;
  return `<article class="change-card" data-type="${change.type}" data-id="${change.id}"><div class="change-card-head"><div class="change-identity"><span class="change-number">${String(index + 1).padStart(2, '0')}</span><span class="change-type type-${change.type}">${labels[change.type]}</span></div><span class="change-location">${location}</span></div>${signals}<div class="passages">${renderSide(change.oldBlock, 'old', diff?.oldParts)}${renderSide(change.newBlock, 'new', diff?.newParts)}</div>${footer}</article>`;
}

function currentReviews() {
  if (!result) return {};
  return Object.fromEntries(result.changes.filter((change) => change.type !== 'unchanged' && reviews[change.id])
    .map((change) => [change.id, reviews[change.id]]));
}

function renderList() {
  if (!result) return;
  const term = search.value.trim().toLocaleLowerCase('fr');
  const visible = result.changes.filter((change) => {
    const filterMatch = activeFilter === 'attention' ? change.signals.length > 0
      : activeFilter === 'all' ? change.type !== 'unchanged' : change.type === activeFilter;
    const searchMatch = !term || `${change.oldBlock?.text ?? ''} ${change.newBlock?.text ?? ''}`.toLocaleLowerCase('fr').includes(term);
    return filterMatch && searchMatch;
  }).sort((a, b) => b.priority - a.priority || (a.newBlock?.index ?? a.oldBlock?.index) - (b.newBlock?.index ?? b.oldBlock?.index));
  list.innerHTML = visible.length ? visible.map(renderCard).join('')
    : `<div class="empty-state"><strong>Aucun passage ici.</strong><p>Essayez un autre filtre ou effacez votre recherche.</p></div>`;
}

function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readTextFile(side, file) {
  if (!file) return;
  if (file.size > 1_000_000) { setStatus('Fichier trop volumineux. Maximum 200 000 caractères par version.', true); return; }
  try {
    const value = await file.text();
    setDocument(side, value, file.name);
    setStatus(`${file.name} importé. Cliquez sur « Analyser les différences » pour actualiser le résultat.`);
  } catch {
    setStatus(`Lecture impossible : ${file.name}`, true);
  }
}

for (const [side, item] of Object.entries(fields)) {
  item.text.addEventListener('input', () => { dirty = true; updateCounts(); setStatus('Texte modifié. Cliquez sur « Analyser les différences » pour actualiser le résultat.'); });
  item.file.addEventListener('change', () => readTextFile(side, item.file.files[0]));
  $(`#${side}FileButton`).addEventListener('click', () => item.file.click());
  item.drop.addEventListener('dragover', (event) => { event.preventDefault(); item.drop.classList.add('dragging'); });
  item.drop.addEventListener('dragleave', () => item.drop.classList.remove('dragging'));
  item.drop.addEventListener('drop', (event) => { event.preventDefault(); item.drop.classList.remove('dragging'); readTextFile(side, event.dataTransfer.files[0]); });
}

$('#analyzeButton').addEventListener('click', analyze);
$('#exampleButton').addEventListener('click', loadExample);
$('#swapButton').addEventListener('click', () => {
  const oldText = fields.old.text.value;
  const oldName = fields.old.name.value;
  setDocument('old', fields.new.text.value, fields.new.name.value);
  setDocument('new', oldText, oldName);
  reviews = Object.create(null);
  analyze();
});
$('#reportButton').addEventListener('click', () => {
  if (!result) return;
  if (dirty && !analyze()) return;
  const today = new Date().toISOString().slice(0, 10);
  download(`bascule-rapport-${today}.md`, makeMarkdownReport(result, { oldName: fields.old.name.value, newName: fields.new.name.value }, currentReviews()), 'text/markdown;charset=utf-8');
  setStatus('Rapport Markdown exporté.');
});
$('#projectExportButton').addEventListener('click', () => {
  if (dirty && fields.old.text.value.trim() && fields.new.text.value.trim() && !analyze()) return;
  const project = { format: 'bascule-project-v1', oldName: fields.old.name.value, newName: fields.new.name.value, oldText: fields.old.text.value, newText: fields.new.text.value, reviews: dirty ? {} : currentReviews() };
  download('bascule-projet.json', JSON.stringify(project, null, 2), 'application/json;charset=utf-8');
  setStatus('Projet exporté en JSON.');
});
$('#projectImportButton').addEventListener('click', () => $('#projectFile').click());
$('#projectFile').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1_000_000) throw new Error('Projet trop volumineux.');
    const project = JSON.parse(await file.text());
    if (project.format !== 'bascule-project-v1' || typeof project.oldText !== 'string' || typeof project.newText !== 'string') throw new Error('Format de projet non reconnu.');
    setDocument('old', project.oldText, String(project.oldName ?? 'Version précédente'));
    setDocument('new', project.newText, String(project.newName ?? 'Version actuelle'));
    reviews = Object.create(null);
    const importedReviews = project.reviews && typeof project.reviews === 'object' ? project.reviews : {};
    for (const [id, review] of Object.entries(importedReviews)) {
      if (/^c-[0-9a-z]+$/u.test(id) && ['todo', 'verified', 'question'].includes(review?.state)) {
        reviews[id] = { state: review.state, note: typeof review.note === 'string' ? review.note.slice(0, 500) : '' };
      }
    }
    analyze();
    setStatus('Projet chargé et analysé.');
  } catch (error) { setStatus(error.message || 'Projet illisible.', true); }
  event.target.value = '';
});
filters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  activeFilter = button.dataset.filter;
  render();
});
search.addEventListener('input', renderList);
list.addEventListener('click', (event) => {
  const reviewButton = event.target.closest('[data-review-state]');
  if (reviewButton) {
    const id = reviewButton.closest('[data-id]').dataset.id;
    reviews[id] = { ...(reviews[id] ?? { note: '' }), state: reviewButton.dataset.reviewState };
    renderProgress();
    renderList();
    return;
  }
  const button = event.target.closest('[data-side][data-line]');
  if (!button) return;
  const item = fields[button.dataset.side];
  const lineNumber = Number(button.dataset.line);
  const lines = item.text.value.split('\n');
  const offset = lines.slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0);
  item.text.focus();
  item.text.setSelectionRange(offset, offset + (lines[lineNumber - 1]?.length ?? 0));
  item.text.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
list.addEventListener('input', (event) => {
  if (!event.target.matches('[data-review-note]')) return;
  const id = event.target.closest('[data-id]').dataset.id;
  reviews[id] = { ...(reviews[id] ?? { state: 'todo' }), note: event.target.value };
});

loadExample();
