import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDocuments, segmentDocument, wordDiff, makeMarkdownReport, LIMITS } from '../engine.mjs';
import { EXAMPLE } from '../example.mjs';

test('segmentation retains original line positions and isolates Markdown bullets', () => {
  const blocks = segmentDocument('# Titre\n\nTexte sur\ndeux lignes.\n\n- Première\n- Deuxième');
  assert.deepEqual(blocks.map((block) => block.line), [1, 3, 6, 7]);
  assert.equal(blocks[1].text, 'Texte sur\ndeux lignes.');
});

test('unchanged content has no false signal', () => {
  const result = compareDocuments('A\n\nB', 'A\n\nB');
  assert.equal(result.counts.unchanged, 2);
  assert.equal(result.attention, 0);
});

test('a pure reorder is identified as a move', () => {
  const result = compareDocuments('Alpha\n\nBeta\n\nGamma', 'Gamma\n\nAlpha\n\nBeta');
  assert.equal(result.counts.moved, 1);
  assert.equal(result.counts.modified, 0);
  assert.equal(result.counts.added, 0);
  assert.equal(result.counts.removed, 0);
});

test('number and negation changes receive explicit signals', () => {
  const result = compareDocuments('Le prestataire ne peut pas répondre sous 30 jours.', 'Le prestataire peut répondre sous 45 jours.');
  const change = result.changes.find((entry) => entry.type === 'modified');
  assert.ok(change);
  assert.deepEqual(change.signals.map((signal) => signal.kind), ['number', 'modality']);
  assert.equal(change.signals[0].before, '30 jours');
  assert.equal(change.signals[0].after, '45 jours');
  assert.equal(result.attention, 1);
});

test('removing one negation is detected even when another remains', () => {
  const result = compareDocuments('Le prestataire ne peut pas agir sans accord.', 'Le prestataire peut agir sans accord.');
  const change = result.changes.find((entry) => entry.type === 'modified');
  assert.ok(change.signals.some((signal) => signal.kind === 'modality'));
});

test('section numbering alone does not trigger a numeric signal', () => {
  const result = compareDocuments('Point commun.', 'Point commun.\n\n10. Le client peut demander un audit.');
  const addition = result.changes.find((entry) => entry.type === 'added');
  assert.ok(addition);
  assert.equal(addition.signals.some((signal) => signal.kind === 'number'), false);
});

test('additions and removals remain separate when wording is unrelated', () => {
  const result = compareDocuments('Point commun.\n\nAncien secret.', 'Point commun.\n\nUne clause entièrement différente apparaît.');
  assert.equal(result.counts.added, 1);
  assert.equal(result.counts.removed, 1);
});

test('word-level highlighting reconstructs each source exactly', () => {
  const before = 'Le délai est de 30 jours.';
  const after = 'Le délai est de 45 jours.';
  const diff = wordDiff(before, after);
  assert.equal(diff.oldParts.map((part) => part.text).join(''), before);
  assert.equal(diff.newParts.map((part) => part.text).join(''), after);
  assert.ok(diff.oldParts.some((part) => part.changed && part.text.includes('30')));
  assert.ok(diff.newParts.some((part) => part.changed && part.text.includes('45')));
});

test('example report gives source evidence and all expected types', () => {
  const result = compareDocuments(EXAMPLE.oldText, EXAMPLE.newText);
  assert.ok(result.counts.modified >= 5);
  assert.equal(result.counts.added, 1);
  assert.ok(result.attention >= 5);
  const report = makeMarkdownReport(result, EXAMPLE);
  assert.match(report, /30 jours/);
  assert.match(report, /15 jours/);
  assert.match(report, /Ajouté/);
  assert.match(report, /ancienne ligne/);
});

test('review status and note follow a stable change into the report', () => {
  const result = compareDocuments(EXAMPLE.oldText, EXAMPLE.newText);
  const first = result.changes.find((change) => change.type === 'modified');
  const again = compareDocuments(EXAMPLE.oldText, EXAMPLE.newText).changes.find((change) => change.type === 'modified');
  assert.equal(first.id, again.id);
  const report = makeMarkdownReport(result, EXAMPLE, { [first.id]: { state: 'question', note: 'Demander une justification.' } });
  assert.match(report, /1 questions/);
  assert.match(report, /Question ouverte/);
  assert.match(report, /Demander une justification/);
});

test('oversized input is rejected before expensive comparison', () => {
  assert.throws(() => segmentDocument('x'.repeat(LIMITS.characters + 1)), RangeError);
});
