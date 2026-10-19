'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const tracker = require('../src/compat/kiro-chat-changes.js');

function repository(t) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-changes-test-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()));
        assert(path.basename(cwd).startsWith('kiro-changes-test-'));
        fs.rmSync(cwd, { recursive: true, force: true });
    });
    const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    const write = (name, text) => fs.writeFileSync(path.join(cwd, name), text);
    git('init', '--quiet'); write('base.c', 'original\n'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    return { cwd, write };
}

test('changes after 230 preexisting dirty files are counted and retain their real baseline', async t => {
    const { cwd, write } = repository(t);
    for (let i = 0; i < 230; i++) write('old-' + String(i).padStart(3, '0') + '.c', 'older unrelated edit\n');
    write('z-target.c', 'older target edit\n');
    const batch = await tracker.begin(cwd, 'late-change');
    const target = path.join(cwd, 'z-target.c');
    tracker.observe(batch, { kind: 'edit', status: 'pending', locations: [{ path: target }] });
    write('z-target.c', 'actual current edit\n');
    write('z-new.c', 'new file\n');
    write('base.c', 'changed clean file\n');
    const result = await tracker.finish(batch);
    assert.equal(result.totalFiles, 3);
    assert.equal(result.files.length, 3);
    assert.equal(result.files[0].name, 'z-target.c');
    assert.equal(result.files[0].before, 'older target edit\n');
    assert.equal(result.files[0].after, 'actual current edit\n');
    assert.equal(result.files.find(file => file.name === 'z-new.c').status, 'added');
    assert.equal(result.files.find(file => file.name === 'base.c').before, 'original\n');
    assert(!result.files.some(file => file.name.startsWith('old-')));
    assert.deepEqual(result.warnings, []);
});

test('display cap applies to real changes and preserves total count and CLI priorities', async t => {
    const { cwd, write } = repository(t);
    for (let i = 0; i < 240; i++) write('file-' + String(i).padStart(3, '0') + '.c', 'before\n');
    const batch = await tracker.begin(cwd, 'many-real-changes');
    tracker.observe(batch, { kind: 'edit', locations: [{ path: path.join(cwd, 'file-239.c') }] });
    for (let i = 0; i < 240; i++) write('file-' + String(i).padStart(3, '0') + '.c', 'after\n');
    const result = await tracker.finish(batch);
    assert.equal(result.totalFiles, 240);
    assert.equal(result.files.length, 200);
    assert.equal(result.files[0].name, 'file-239.c');
    assert(result.warnings.some(message => message.includes('240')));
});

test('text budget exhaustion does not turn old changes into new changes or hide late edits', async t => {
    const { cwd, write } = repository(t);
    const text = 'a'.repeat(600 * 1024);
    for (let i = 0; i < 30; i++) write('old-' + String(i).padStart(3, '0') + '.c', text);
    write('z-target.c', 'b'.repeat(300 * 1024));
    const batch = await tracker.begin(cwd, 'over-budget');
    assert(batch.bytes <= 16 * 1024 * 1024);
    write('z-target.c', 'c'.repeat(300 * 1024));
    const result = await tracker.finish(batch);
    assert.equal(result.totalFiles, 1);
    assert.deepEqual(result.files.map(file => file.name), ['z-target.c']);
    assert.equal(result.files[0].diffKind, 'unavailable');
    assert.equal(result.incomplete, false);
});

test('binary files do not consume the text budget', async t => {
    const { cwd, write } = repository(t);
    const binary = Buffer.alloc(900 * 1024);
    for (let i = 0; i < 20; i++) write('binary-' + String(i).padStart(3, '0') + '.bin', binary);
    write('z-source.c', 'before\n');
    const batch = await tracker.begin(cwd, 'binary-budget');
    write('z-source.c', 'after\n');
    const result = await tracker.finish(batch);
    assert.equal(result.totalFiles, 1);
    assert.equal(result.files[0].diffKind, 'full');
    assert.equal(result.files[0].before, 'before\n');
    assert.equal(result.files[0].after, 'after\n');
});

test('a source edit reverted within the turn does not count as a changed file', async t => {
    const { cwd, write } = repository(t);
    const batch = await tracker.begin(cwd, 'reverted');
    tracker.observe(batch, { kind: 'edit', locations: [{ path: path.join(cwd, 'base.c') }] });
    write('base.c', 'temporary edit\n'); write('base.c', 'original\n');
    const result = await tracker.finish(batch);
    assert.equal(result.totalFiles, 0);
    assert.deepEqual(result.files, []);
});
