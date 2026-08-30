import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, seedUser } from './helpers';
import { parseUsagePage, readUsagePage, UsageQueryError } from '../src/usage';

test('usage pagination is stable when several ledger rows share a timestamp', async t => {
  const fixture = await testDatabase();
  t.after(() => fixture.mf.dispose());
  await seedUser(fixture.db);
  const createdAt = 1_700_000_000;
  for (const id of ['a', 'b', 'c', 'd']) {
    await fixture.db.prepare(
      `INSERT INTO ledger_entries
       (id,user_id,kind,amount_micros,idempotency_key,metadata,created_at)
       VALUES (?, 'user-1', 'adjustment', 1, ?, '{}', ?)`,
    ).bind(id, `usage-page-${id}`, createdAt).run();
  }

  const first = await readUsagePage(fixture.db, 'user-1', '2');
  assert.deepEqual(first.entries.map(entry => entry.id), ['d', 'c']);
  assert.equal(first.next_before, `${createdAt}:c`);
  const second = await readUsagePage(fixture.db, 'user-1', '2', first.next_before!);
  assert.deepEqual(second.entries.map(entry => entry.id), ['b', 'a']);
  assert.equal(second.next_before, null);
});

test('usage query parameters reject non-integer and invalid cursor values', () => {
  for (const limit of ['', '0', '-1', '1.5', 'NaN', '9007199254740992']) {
    assert.throws(() => parseUsagePage(limit), UsageQueryError, `limit=${limit}`);
  }
  for (const before of ['', '-1', '1.5', 'NaN', '123:', ':id', '9007199254740992:id']) {
    assert.throws(() => parseUsagePage(undefined, before), UsageQueryError, `before=${before}`);
  }
  assert.deepEqual(parseUsagePage('500'), { limit: 100, cursor: null });
  assert.deepEqual(parseUsagePage(undefined, '123:entry-id'), {
    limit: 50, cursor: { createdAt: 123, id: 'entry-id' },
  });
});
