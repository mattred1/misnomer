const test = require('node:test');
const assert = require('node:assert/strict');
const { dirOf, baseOf, joinPath, planRenames, planUndo, dirsOf } = require('../renderer/rename.js');

test('dirOf / baseOf / joinPath: handle unix paths and bare names', () => {
    assert.equal(dirOf('/Users/m/receipts/old.pdf'), '/Users/m/receipts');
    assert.equal(baseOf('/Users/m/receipts/old.pdf'), 'old.pdf');
    assert.equal(joinPath('/Users/m/receipts', 'new.pdf'), '/Users/m/receipts/new.pdf');
    // A bare filename has no directory.
    assert.equal(dirOf('old.pdf'), '');
    assert.equal(baseOf('old.pdf'), 'old.pdf');
    assert.equal(joinPath('', 'new.pdf'), 'new.pdf');
    // A trailing slash must not produce a double separator.
    assert.equal(joinPath('/Users/m/receipts/', 'new.pdf'), '/Users/m/receipts/new.pdf');
});

const item = (id, from, name, ext = 'pdf') => ({ id, from, name, ext });

test('planRenames: builds the target path in the source folder', () => {
    const [p] = planRenames([item(1, '/docs/old.pdf', 'invoice-acme')], {});
    assert.equal(p.path, '/docs/invoice-acme.pdf');
    assert.equal(p.changed, true);
    assert.equal(p.caseOnly, false);
});

test('planRenames: a file already named correctly is a no-op', () => {
    const [p] = planRenames([item(1, '/docs/invoice-acme.pdf', 'invoice-acme')], {});
    assert.equal(p.changed, false);
    assert.equal(p.path, '/docs/invoice-acme.pdf');
});

test('planRenames: avoids a filename that already exists on disk', () => {
    const existing = { '/docs': ['invoice-acme.pdf'] };
    const [p] = planRenames([item(1, '/docs/old.pdf', 'invoice-acme')], existing);
    assert.equal(p.target, 'invoice-acme-2.pdf');
});

test('planRenames: keeps suffixing past every collision on disk', () => {
    const existing = { '/docs': ['invoice-acme.pdf', 'invoice-acme-2.pdf', 'invoice-acme-3.pdf'] };
    const [p] = planRenames([item(1, '/docs/old.pdf', 'invoice-acme')], existing);
    assert.equal(p.target, 'invoice-acme-4.pdf');
});

test('planRenames: matches existing files when the directory key differs in case', () => {
    // files:existing() is keyed by the real path, while lookups are case-insensitive.
    const existing = { '/Users/M/Receipts': ['invoice-acme.pdf'] };
    const [p] = planRenames([item(1, '/Users/M/Receipts/old.pdf', 'invoice-acme')], existing);
    assert.equal(p.target, 'invoice-acme-2.pdf');
});

test('planRenames: matches an existing directory whose key case differs from the path', () => {
    const existing = { '/USERS/M/RECEIPTS': ['invoice-acme.pdf'] };
    const [p] = planRenames([item(1, '/users/m/receipts/old.pdf', 'invoice-acme')], existing);
    assert.equal(p.target, 'invoice-acme-2.pdf');
});

test('planRenames: disambiguates two rows that resolve to the same name', () => {
    const plan = planRenames([item(1, '/docs/a.pdf', 'invoice'), item(2, '/docs/b.pdf', 'invoice')], {});
    assert.deepEqual(plan.map((p) => p.target), ['invoice.pdf', 'invoice-2.pdf']);
});

test('planRenames: the same desired name in different folders does not collide', () => {
    const plan = planRenames([item(1, '/a/x.pdf', 'invoice'), item(2, '/b/y.pdf', 'invoice')], {});
    assert.deepEqual(plan.map((p) => p.target), ['invoice.pdf', 'invoice.pdf']);
});

test('planRenames: collision detection is case-insensitive', () => {
    const existing = { '/docs': ['Invoice.PDF'] };
    const [p] = planRenames([item(1, '/docs/old.pdf', 'invoice')], existing);
    assert.equal(p.target, 'invoice-2.pdf');
});

test('planRenames: a case-only rename is allowed even though the name exists', () => {
    const existing = { '/docs': ['invoice.pdf'] };
    const [p] = planRenames([item(1, '/docs/invoice.pdf', 'INVOICE')], existing);
    assert.equal(p.target, 'INVOICE.pdf');
    assert.equal(p.changed, true);
    assert.equal(p.caseOnly, true);
});

test('planRenames: renaming a file to its own current name is not a collision', () => {
    const existing = { '/docs': ['invoice.pdf'] };
    const [p] = planRenames([item(1, '/docs/invoice.pdf', 'invoice')], existing);
    assert.equal(p.changed, false);
});

test('planRenames: handles an empty batch', () => {
    assert.deepEqual(planRenames([], {}), []);
    assert.deepEqual(planRenames(undefined, undefined), []);
});

test('dirsOf: returns distinct directories in order', () => {
    assert.deepEqual(dirsOf(['/a/1.pdf', '/a/2.pdf', '/b/3.pdf']), ['/a', '/b']);
    assert.deepEqual(dirsOf([]), []);
});

const entry = (id, from, to) => ({ id, from, to });

test('planUndo: reverses a single rename', () => {
    const [p] = planUndo([entry(1, '/docs/old.pdf', '/docs/new.pdf')], { '/docs': ['new.pdf'] });
    assert.equal(p.ok, true);
    assert.equal(p.from, '/docs/new.pdf');
    assert.equal(p.to, '/docs/old.pdf');
});

test('planUndo: unwinds multiple renames in reverse order', () => {
    const entries = [entry(1, '/d/a.pdf', '/d/b.pdf'), entry(2, '/d/c.pdf', '/d/d.pdf')];
    const plan = planUndo(entries, { '/d': ['b.pdf', 'd.pdf'] });
    assert.deepEqual(plan.map((p) => [p.from, p.to]), [
        ['/d/d.pdf', '/d/c.pdf'],
        ['/d/b.pdf', '/d/a.pdf']
    ]);
});

test('planUndo: reports a renamed file that is no longer there', () => {
    const [p] = planUndo([entry(1, '/docs/old.pdf', '/docs/new.pdf')], { '/docs': [] });
    assert.equal(p.ok, false);
    assert.equal(p.reason, 'missing');
});

test('planUndo: refuses when the original name has been taken', () => {
    const [p] = planUndo([entry(1, '/docs/old.pdf', '/docs/new.pdf')], { '/docs': ['new.pdf', 'old.pdf'] });
    assert.equal(p.ok, false);
    assert.equal(p.reason, 'occupied');
});

test('planUndo: allows reverting a case-only rename', () => {
    const [p] = planUndo([entry(1, '/docs/invoice.pdf', '/docs/INVOICE.pdf')], { '/docs': ['INVOICE.pdf'] });
    assert.equal(p.ok, true);
    assert.equal(p.to, '/docs/invoice.pdf');
});

test('planUndo: matches existing files when the directory key differs in case', () => {
    const [p] = planUndo([entry(1, '/Docs/old.pdf', '/Docs/new.pdf')], { '/docs': ['new.pdf'] });
    assert.equal(p.ok, true);
});
