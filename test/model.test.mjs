import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

function migrationStatements(sql) {
  const statements = [];
  let statement = '';
  let trigger = false;
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('PRAGMA ')) continue;
    if (!statement) trigger = trimmed.startsWith('CREATE TRIGGER');
    statement += line + '\n';
    if ((trigger && trimmed === 'END;') || (!trigger && trimmed.endsWith(';'))) {
      statements.push(statement);
      statement = '';
    }
  }
  assert.equal(statement, '');
  return statements;
}

// Exercise the checked-in migration against the same local D1 engine used by Wrangler.
test('settlements stay between users while expenses can be organized into groups', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: 'split-it-model-test', modules: true, scriptPath: 'dist/index.js',
    compatibilityDate: '2026-09-12', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'model-test' },
    serviceBindings: { ASSETS: () => new Response('Split It') },
  }));
  try {
    const db = await mf.getD1Database('DB');
    const migration = await readFile(new URL('../migrations/0000_expense_model.sql', import.meta.url), 'utf8');
    for (const statement of migrationStatements(migration)) await db.prepare(statement).run();
    const run = (sql, ...values) => db.prepare(sql).bind(...values).run();
    const first = (sql, ...values) => db.prepare(sql).bind(...values).first();

    const settlementColumns = await db.prepare("PRAGMA table_info('settlements')").all();
    assert.equal(settlementColumns.results.some(({ name }) => name === 'group_id'), false);

    await run("INSERT INTO users(id,display_name) VALUES('alice','Alice'),('bob','Bob')");
    await run("INSERT INTO expenses(id,created_by_user_id,description,currency_code,amount_minor,incurred_at) VALUES('lunch','alice','Lunch','CAD',1000,1)");
    await run("INSERT INTO expense_payments VALUES('lunch','alice',1000)");
    await run("INSERT INTO expense_shares VALUES('lunch','alice',500),('lunch','bob',500)");
    await run("INSERT INTO expense_allocations VALUES('lunch','bob','alice',500)");
    assert.equal((await first("SELECT net_minor FROM pair_balances WHERE currency_code='CAD' AND user_low_id='alice' AND user_high_id='bob'")).net_minor, -500);
    assert.equal((await first("SELECT group_id FROM expense_involvement WHERE expense_id='lunch' AND user_id='bob'")).group_id, null);

    await run("INSERT INTO settlements(id,paid_by_user_id,paid_to_user_id,recorded_by_user_id,currency_code,amount_minor,settled_at) VALUES('payment','bob','alice','bob','CAD',200,2)");
    assert.equal((await first("SELECT net_minor FROM pair_balances WHERE currency_code='CAD' AND user_low_id='alice' AND user_high_id='bob'")).net_minor, -300);

    await run("INSERT INTO groups(id,name,default_currency_code,created_by_user_id) VALUES('trip','Trip','USD','alice')");
    await run("INSERT INTO group_members(group_id,user_id) VALUES('trip','alice')");
    await run("UPDATE expenses SET group_id='trip' WHERE id='lunch'");
    assert.equal((await first("SELECT group_id FROM expense_involvement WHERE expense_id='lunch' AND user_id='bob'")).group_id, 'trip');
    assert.equal((await first("SELECT net_minor FROM pair_balances WHERE currency_code='CAD' AND user_low_id='alice' AND user_high_id='bob'")).net_minor, -300);

    await run("DELETE FROM groups WHERE id='trip'");
    assert.equal((await first("SELECT group_id FROM expenses WHERE id='lunch'")).group_id, null);
    assert.equal((await first("SELECT group_id FROM expense_involvement WHERE expense_id='lunch' AND user_id='bob'")).group_id, null);
    assert.equal((await first("SELECT net_minor FROM pair_balances WHERE currency_code='CAD' AND user_low_id='alice' AND user_high_id='bob'")).net_minor, -300);

    await run("INSERT INTO settlements(id,paid_by_user_id,paid_to_user_id,recorded_by_user_id,currency_code,amount_minor,settled_at) VALUES('usd-payment','bob','alice','bob','USD',50,3)");
    assert.equal((await first("SELECT net_minor FROM pair_balances WHERE currency_code='USD' AND user_low_id='alice' AND user_high_id='bob'")).net_minor, 50);
    await assert.rejects(run("UPDATE expenses SET currency_code='USD' WHERE id='lunch'"));
  } finally {
    await mf.dispose();
  }
});
