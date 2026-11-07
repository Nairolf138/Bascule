/** Bascule's deterministic, offline document comparison engine. */

export const LIMITS = Object.freeze({ characters: 200_000, blocks: 350 });

const clean = (value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const keyOf = (value) => clean(value).toLocaleLowerCase('fr');
const wordTokens = (value) => keyOf(value).match(/[\p{L}\p{N}]+/gu) ?? [];

export function segmentDocument(source) {
  if (typeof source !== 'string') throw new TypeError('Le document doit être du texte.');
  if (source.length > LIMITS.characters) throw new RangeError(`Maximum ${LIMITS.characters.toLocaleString('fr-FR')} caractères par version.`);

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let pending = [];
  let start = 1;

  function flush() {
    const text = pending.join('\n').trim();
    if (text) blocks.push({ index: blocks.length, line: start, text, key: keyOf(text) });
    pending = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    const standalone = /^\s*(?:#{1,6}\s|[-*•]\s|\d+[.)]\s)/u.test(line);
    if (standalone) flush();
    if (!pending.length) start = i + 1;
    pending.push(line);
    if (standalone) flush();
  }
  flush();
  if (blocks.length > LIMITS.blocks) throw new RangeError(`Maximum ${LIMITS.blocks} paragraphes par version.`);
  return blocks;
}

function lcsPairs(before, after) {
  const n = before.length;
  const m = after.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = before[i].key === after[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i].key === after[j].key) {
      pairs.push([i++, j++]);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function dice(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let overlap = 0;
  for (const item of b) {
    const count = counts.get(item) ?? 0;
    if (count > 0) {
      overlap++;
      counts.set(item, count - 1);
    }
  }
  return 2 * overlap / (a.length + b.length);
}

function features(block) {
  const value = block.key;
  const compact = value.replace(/\s+/gu, ' ');
  const chars = Array.from(compact);
  const bigrams = [];
  for (let i = 0; i < chars.length - 1; i++) bigrams.push(chars[i] + chars[i + 1]);
  return { words: wordTokens(value), bigrams };
}

function similarity(left, right) {
  const words = dice(left.words, right.words);
  const chars = dice(left.bigrams, right.bigrams);
  return 0.48 * words + 0.52 * chars;
}

function numbersIn(text) {
  // Section numbers ("7. Prix") identify a block; they are not a changed amount.
  const withoutListNumber = text.replace(/^\s*(?:\d+[.)]\s+|#{1,6}\s+)/u, '');
  return [...withoutListNumber.matchAll(/\b\d+(?:[.,]\d+)*(?:\s*(?:%|€|\$|jours?|mois|ans?|heures?|days?|months?|years?))?/giu)]
    .map((match) => match[0].replace(/\s+/gu, ' ').trim().toLocaleLowerCase('fr'));
}

function sameBag(left, right) {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function modalSignature(text) {
  const value = keyOf(text);
  return {
    obligation: /\b(?:doit|devra|devront|obligatoire|requis|shall|must|required)\b/u.test(value),
    permission: /\b(?:peut|pourra|pourront|facultatif|may|optional)\b/u.test(value),
    negation: (value.match(/\b(?:pas|sans|aucun|aucune|jamais|interdit|interdite|not|never|prohibited)\b/gu) ?? []).sort().join('|'),
  };
}

function signalsFor(type, oldBlock, newBlock) {
  if (type === 'unchanged' || type === 'moved') return [];
  const oldText = oldBlock?.text ?? '';
  const newText = newBlock?.text ?? '';
  const flags = [];
  const oldNumbers = numbersIn(oldText);
  const newNumbers = numbersIn(newText);
  if (!sameBag(oldNumbers, newNumbers) && (oldNumbers.length || newNumbers.length)) {
    flags.push({ kind: 'number', label: 'Chiffre ou délai', before: oldNumbers.join(', ') || '—', after: newNumbers.join(', ') || '—' });
  }
  const oldModal = modalSignature(oldText);
  const newModal = modalSignature(newText);
  if (Object.keys(oldModal).some((name) => oldModal[name] !== newModal[name])) {
    flags.push({ kind: 'modality', label: 'Droit, devoir ou négation', before: '', after: '' });
  }
  return flags;
}

function changeId(type, oldBlock, newBlock) {
  const source = `${type}\u0000${oldBlock?.line ?? ''}\u0000${oldBlock?.text ?? ''}\u0000${newBlock?.line ?? ''}\u0000${newBlock?.text ?? ''}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `c-${(hash >>> 0).toString(36)}`;
}

function makeChange(type, oldBlock, newBlock, confidence = 1) {
  const signals = signalsFor(type, oldBlock, newBlock);
  const base = { modified: 48, removed: 45, added: 30, moved: 12, unchanged: 0 }[type];
  const priority = Math.min(100, base + (signals.some((s) => s.kind === 'number') ? 27 : 0)
    + (signals.some((s) => s.kind === 'modality') ? 24 : 0));
  return { id: changeId(type, oldBlock, newBlock), type, oldBlock, newBlock, confidence, signals, priority };
}

export function compareDocuments(oldText, newText) {
  const before = segmentDocument(oldText);
  const after = segmentDocument(newText);
  if (!before.length || !after.length) throw new Error('Les deux versions doivent contenir du texte.');
  const usedBefore = new Set();
  const usedAfter = new Set();
  const changes = [];

  for (const [i, j] of lcsPairs(before, after)) {
    usedBefore.add(i);
    usedAfter.add(j);
    changes.push(makeChange('unchanged', before[i], after[j]));
  }

  // Exact matches outside the common sequence have changed position.
  for (let i = 0; i < before.length; i++) {
    if (usedBefore.has(i)) continue;
    let best = -1;
    let distance = Infinity;
    for (let j = 0; j < after.length; j++) {
      if (usedAfter.has(j) || before[i].key !== after[j].key) continue;
      const current = Math.abs(i / Math.max(1, before.length) - j / Math.max(1, after.length));
      if (current < distance) { best = j; distance = current; }
    }
    if (best >= 0) {
      usedBefore.add(i);
      usedAfter.add(best);
      changes.push(makeChange('moved', before[i], after[best]));
    }
  }

  // Conservative one-to-one pairing. A doubtful match stays as an addition + removal.
  const oldFeatures = before.map(features);
  const newFeatures = after.map(features);
  const candidates = [];
  for (let i = 0; i < before.length; i++) {
    if (usedBefore.has(i)) continue;
    for (let j = 0; j < after.length; j++) {
      if (usedAfter.has(j)) continue;
      const score = similarity(oldFeatures[i], newFeatures[j]);
      const threshold = Math.min(before[i].text.length, after[j].text.length) < 24 ? 0.66 : 0.52;
      if (score >= threshold) candidates.push({ i, j, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.i - a.j) - Math.abs(b.i - b.j));
  for (const { i, j, score } of candidates) {
    if (usedBefore.has(i) || usedAfter.has(j)) continue;
    usedBefore.add(i);
    usedAfter.add(j);
    changes.push(makeChange('modified', before[i], after[j], score));
  }
  before.forEach((block, i) => { if (!usedBefore.has(i)) changes.push(makeChange('removed', block, null)); });
  after.forEach((block, j) => { if (!usedAfter.has(j)) changes.push(makeChange('added', null, block)); });

  const counts = Object.fromEntries(['modified', 'added', 'removed', 'moved', 'unchanged'].map((type) =>
    [type, changes.filter((change) => change.type === type).length]));
  const attention = changes.filter((change) => change.signals.length).length;
  return { before, after, changes, counts, attention };
}

function visualTokens(text) {
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

export function wordDiff(oldText, newText) {
  const left = visualTokens(oldText);
  const right = visualTokens(newText);
  if (left.length > 360 || right.length > 360) {
    return { oldParts: [{ text: oldText, changed: true }], newParts: [{ text: newText, changed: true }] };
  }
  const dp = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldParts = [];
  const newParts = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      oldParts.push({ text: left[i], changed: false });
      newParts.push({ text: right[j], changed: false });
      i++; j++;
    } else if (i < left.length && (j >= right.length || dp[i + 1][j] >= dp[i][j + 1])) {
      oldParts.push({ text: left[i++], changed: true });
    } else {
      newParts.push({ text: right[j++], changed: true });
    }
  }
  return { oldParts, newParts };
}

export function makeMarkdownReport(result, names = {}, reviews = {}) {
  const oldName = names.oldName || 'Version précédente';
  const newName = names.newName || 'Version actuelle';
  const visible = result.changes.filter((change) => change.type !== 'unchanged')
    .sort((a, b) => b.priority - a.priority || (a.newBlock?.index ?? a.oldBlock?.index) - (b.newBlock?.index ?? b.oldBlock?.index));
  const checked = visible.filter((change) => reviews[change.id]?.state === 'verified').length;
  const questions = visible.filter((change) => reviews[change.id]?.state === 'question').length;
  const lines = [
    '# Rapport Bascule', '',
    `- Comparaison : ${oldName} → ${newName}`,
    `- Date : ${new Date().toLocaleString('fr-FR')}`,
    `- À relire en priorité : ${result.attention}`,
    `- Reformulés : ${result.counts.modified} · Ajoutés : ${result.counts.added} · Supprimés : ${result.counts.removed} · Déplacés : ${result.counts.moved} · Inchangés : ${result.counts.unchanged}`,
    `- Relecture : ${checked} vérifiés · ${questions} questions · ${visible.length - checked - questions} à faire`,
    '',
    '> Les signaux sont des indices de relecture fondés sur le texte, sans interprétation juridique ou sémantique.',
    '',
  ];
  const labels = { modified: 'Reformulé', added: 'Ajouté', removed: 'Supprimé', moved: 'Déplacé' };
  const reviewLabels = { verified: 'Vérifié', question: 'Question ouverte', todo: 'À faire' };
  visible.forEach((change, index) => {
    lines.push(`## ${index + 1}. ${labels[change.type]}`);
    lines.push(`Source : ancienne ligne ${change.oldBlock?.line ?? '—'} · nouvelle ligne ${change.newBlock?.line ?? '—'}`);
    if (change.signals.length) lines.push(`Signaux : ${change.signals.map((signal) => signal.label + (signal.kind === 'number' ? ` (${signal.before} → ${signal.after})` : '')).join(' ; ')}`);
    const review = reviews[change.id] ?? { state: 'todo', note: '' };
    lines.push(`Relecture : ${reviewLabels[review.state] ?? reviewLabels.todo}`);
    if (review.note?.trim()) lines.push(`Note : ${review.note.trim().replace(/\s+/gu, ' ')}`);
    if (change.oldBlock) {
      lines.push('', '**Avant**', '', ...change.oldBlock.text.split('\n').map((line) => `> ${line}`));
    }
    if (change.newBlock) {
      lines.push('', '**Après**', '', ...change.newBlock.text.split('\n').map((line) => `> ${line}`));
    }
    lines.push('');
  });
  return lines.join('\n');
}
