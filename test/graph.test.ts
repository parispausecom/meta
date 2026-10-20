import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.META_PAGE_ACCESS_TOKEN ??= 'test-token';
const { graphGetAll } = await import('../src/lib/graph.js');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TOO_MUCH = { error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 } };

test('réduit la taille de page quand Meta demande moins de données, et la garde', async () => {
  const limits: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const limit = Number(url.searchParams.get('limit'));
    limits.push(limit);
    if (limit > 10) return json(500, TOO_MUCH);
    const after = url.searchParams.get('after');
    return after
      ? json(200, { data: [{ id: 'b' }] })
      : json(200, { data: [{ id: 'a' }], paging: { next: 'x', cursors: { after: 'c1' } } });
  }) as typeof fetch;

  const lines: string[] = [];
  const items = await graphGetAll<{ id: string }>('123/tags', {}, 40, (l) => lines.push(l));

  assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
  // 40 et 20 refusés, 10 accepté, puis la page suivante directement à 10.
  assert.deepEqual(limits, [40, 20, 10, 10]);
  assert.equal(lines.length, 2);
});

test('remonte les autres erreurs Meta sans réessayer', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return json(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
  }) as typeof fetch;

  await assert.rejects(graphGetAll('123/tags', {}, 40), /Invalid OAuth/);
  assert.equal(calls, 1);
});
