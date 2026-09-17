import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CORE_SPANISH_VERBS, coreVerbRank, groupVerbCatalog } from '../src/lib/verbSelection.ts';

// Independent transcription of the learner-supplied ranked table, not morphology
// or the legacy daily-email rotation. Incidental mentions (preguntar) are excluded.
const expected = 'ser haber estar tener hacer poder decir ir ver dar saber querer llegar pasar deber poner parecer quedar creer hablar llevar dejar seguir encontrar llamar venir pensar salir volver tomar conocer vivir sentir tratar mirar contar empezar esperar buscar existir entrar trabajar escribir perder producir ocurrir entender pedir recibir recordar terminar permitir aparecer conseguir comenzar servir sacar necesitar mantener resultar'.split(' ');
const catalog = JSON.parse(readFileSync(new URL('../src/data/generated/verbs.json', import.meta.url)));
const names = (entries) => entries.map((entry) => entry.verb);

test('Core 60 exactly matches all supplied ranks with unique entries', () => {
  assert.deepEqual([...CORE_SPANISH_VERBS], expected);
  assert.equal(new Set(CORE_SPANISH_VERBS).size, 60);
  expected.forEach((verb, index) => assert.equal(coreVerbRank(verb), index + 1));
  assert.equal(coreVerbRank('preguntar'), undefined);
});

test('completed core and non-core verbs lead, then ranked uncompleted core, then stable remainder', () => {
  const progress = { ser: { completed: 1 }, volar: { completed: 1 }, pagar: { completed: 0, full_pass_count: 1 } };
  const groups = groupVerbCatalog(catalog.verbs, progress);
  assert.deepEqual(names(groups.completed), ['ser', 'volar']);
  assert.deepEqual(names(groups.core), expected.filter((verb) => verb !== 'ser'));
  assert.deepEqual(names(groups.other), names(catalog.verbs).filter((verb) => !expected.includes(verb) && verb !== 'volar'));
  assert.equal(groups.coreCompleted, 1);
  assert.deepEqual(groups.missingCore, []);
  const flattened = [...groups.completed, ...groups.core, ...groups.other];
  assert.equal(flattened.length, catalog.verbs.length);
  assert.equal(new Set(names(flattened)).size, catalog.verbs.length);
  for (const entry of flattened) assert.equal(entry, catalog.verbs.find((v) => v.verb === entry.verb));
});

test('API ordering and legacy rotation never change paper ranks or completion precedence', () => {
  const reversed = [...catalog.verbs].reverse();
  const progress = { haber: { completed: 1 }, traer: { completed: 1 } };
  const groups = groupVerbCatalog(reversed, progress);
  assert.deepEqual(names(groups.completed), names(reversed).filter((verb) => ['haber', 'traer'].includes(verb)));
  assert.deepEqual(names(groups.core), expected.filter((verb) => verb !== 'haber'));
});

test('completion updates move one verb without duplicates or resetting other entries', () => {
  const before = groupVerbCatalog(catalog.verbs, { ser: { completed: 1 } });
  const after = groupVerbCatalog(catalog.verbs, { ser: { completed: 1 }, haber: { completed: 1 } });
  assert.equal(after.completed.length, before.completed.length + 1);
  assert.equal(after.core.length, before.core.length - 1);
  assert.equal(after.core[0].verb, 'estar');
  assert.equal(after.coreCompleted, 2);
  assert.deepEqual(after.other, before.other);
});

test('all completed, no completed, empty catalog, missing core and custom verbs are explicit', () => {
  const all = groupVerbCatalog(catalog.verbs, Object.fromEntries(catalog.verbs.map((v) => [v.verb, { completed: 1 }])));
  assert.equal(all.completed.length, catalog.verbs.length);
  assert.deepEqual(all.core, []);
  assert.deepEqual(all.other, []);
  assert.equal(all.coreCompleted, 60);
  assert.deepEqual(groupVerbCatalog([], {}).missingCore, expected);
  const custom = groupVerbCatalog([{ verb: 'customizar' }, { verb: 'haber' }], {});
  assert.deepEqual(names(custom.core), ['haber']);
  assert.deepEqual(names(custom.other), ['customizar']);
  assert.equal(custom.missingCore.length, 59);
  assert.equal(groupVerbCatalog(catalog.verbs, {}).core.length, 60);
});

test('grouping does not mutate catalog entries, progress, categories or assignments', () => {
  const entries = Object.freeze(catalog.verbs.map((v) => Object.freeze({ ...v, assignments: Object.freeze(v.assignments) })));
  const progress = Object.freeze({ estar: Object.freeze({ completed: 1, required_full_passes: 1, full_pass_count: 1 }) });
  const before = JSON.stringify({ entries, progress });
  const groups = groupVerbCatalog(entries, progress);
  assert.equal(groups.completed[0].verb, 'estar'); // Stored completion is authoritative, not inferred from irregular category.
  assert.equal(JSON.stringify({ entries, progress }), before);
});
