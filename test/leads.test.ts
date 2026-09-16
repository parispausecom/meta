import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRow, newRows } from '../src/lib/leads.js';

test('mappe les champs standards de Meta', () => {
  const row = toRow({
    id: 'LEAD_1',
    createdTime: '2026-09-01T10:00:00+0000',
    fields: {
      full_name: 'Marie Dupont',
      email: 'marie@example.com',
      phone_number: '+33612345678',
    },
  });
  assert.deepEqual(row, [
    '2026-09-01T10:00:00+0000',
    'Marie Dupont',
    'marie@example.com',
    '+33612345678',
    '',
    '',
    'LEAD_1',
  ]);
});

test("accepte les libellés français d'un formulaire personnalisé", () => {
  const row = toRow({
    id: 'LEAD_2',
    createdTime: '2026-09-01T11:00:00+0000',
    fields: { nom: 'Jean Martin', courriel: 'jean@example.com', 'téléphone': '0698765432' },
  });
  assert.equal(row[1], 'Jean Martin');
  assert.equal(row[2], 'jean@example.com');
  assert.equal(row[3], '0698765432');
});

test("laisse vides les champs absents plutôt que d'écrire undefined", () => {
  const row = toRow({ id: 'LEAD_3', createdTime: 'T', fields: { email: 'a@b.c' } });
  assert.equal(row[1], '');
  assert.equal(row[3], '');
  assert.ok(!row.includes(undefined as unknown as string));
});

test('retombe sur first_name quand full_name est absent', () => {
  const row = toRow({ id: 'L', createdTime: 'T', fields: { first_name: 'Léa' } });
  assert.equal(row[1], 'Léa');
});

test('produit une date même sans created_time', () => {
  const row = toRow({ id: 'L', fields: {} });
  assert.ok(!Number.isNaN(Date.parse(row[0])), 'la date doit être analysable');
});

test('survit à un lead sans aucun champ', () => {
  const row = toRow({});
  assert.equal(row.length, 7);
  assert.equal(row[6], '');
});

test('conserve entreprise et profil des formulaires Pausecom', () => {
  const row = toRow({
    id: 'LEAD_PC',
    createdTime: 'T',
    fields: {
      full_name: 'Claire Martin',
      phone_number: '+33600000000',
      company_name: 'Le Bistrot',
      'vous_êtes_?': 'restaurateur',
    },
  });
  assert.equal(row[4], 'Le Bistrot');
  assert.equal(row[5], 'restaurateur');
  assert.equal(row[2], '', "ces formulaires ne collectent pas d'email");
});

test('le tuple renvoyé a toujours sept colonnes', () => {
  // Le type LeadRow le garantit à la compilation ; ce test protège contre une
  // régression qui contournerait le typage (données venant de l'extérieur).
  const row = toRow({ id: 'X', fields: { email: 'a@b.c', full_name: 'N' } });
  assert.equal(row.length, 7);
  row.forEach((cell) => assert.equal(typeof cell, 'string'));
});

test('newRows écarte les leads déjà présents dans la feuille', () => {
  const rows = newRows(
    [
      { id: 'A', createdTime: '2026-01-02T00:00:00+0000', fields: { full_name: 'Ancien' } },
      { id: 'B', createdTime: '2026-01-03T00:00:00+0000', fields: { full_name: 'Nouveau' } },
    ],
    new Set(['A'])
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.[1], 'Nouveau');
});

test('newRows écarte aussi les doublons internes au lot', () => {
  const lead = { id: 'A', createdTime: '2026-01-02T00:00:00+0000', fields: {} };
  assert.equal(newRows([lead, lead], new Set()).length, 1);
});

test('newRows trie du plus ancien au plus récent', () => {
  const rows = newRows(
    [
      { id: 'B', createdTime: '2026-03-01T00:00:00+0000', fields: {} },
      { id: 'A', createdTime: '2026-01-01T00:00:00+0000', fields: {} },
    ],
    new Set()
  );
  assert.deepEqual(rows.map((r) => r[6]), ['A', 'B']);
});

test('newRows garde un lead sans identifiant plutôt que de le perdre', () => {
  assert.equal(newRows([{ createdTime: 'T', fields: {} }], new Set()).length, 1);
});

test('reconnaît un identifiant de lead stocké en nombre par Google Sheets', async () => {
  const { cellToId } = await import('../src/lib/sheets.js');
  assert.equal(cellToId(1761578678529790), '1761578678529790');
  assert.equal(cellToId(' 1398332465720097 '), '1398332465720097');
  assert.equal(cellToId(''), '');
  assert.equal(cellToId(undefined), '');
  // Au-delà de 2^53 le nombre a déjà perdu des chiffres : mieux vaut ne rien
  // reconnaître que confondre deux leads.
  assert.equal(cellToId(2 ** 60), '');
});
