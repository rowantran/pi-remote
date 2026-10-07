import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import {
  completePath, filesystemMetadata, MAX_COMPLETION_ITEMS, MAX_DIRECTORY_ENTRIES,
  MAX_IMAGE_BYTES, MAX_TEXT_BYTES, readAttachment, serveFileRequest,
} from '../src/files.js';

const execute = promisify(execFile);
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-remote-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// All fixtures are local scratch files. These tests never start Pi or call a model.
test('completion sorts directories first and keeps raw spaces and display prefixes', async t => {
  const cwd = await temporary(t);
  await Promise.all([
    mkdir(join(cwd, 'z directory')), mkdir(join(cwd, 'a directory')),
    writeFile(join(cwd, 'z file.txt'), ''), writeFile(join(cwd, 'a file.txt'), ''),
  ]);
  const result = await completePath({ prefix: '', cwd });
  assert.deepEqual(result, { items: [
    { value: 'a directory/', label: 'a directory/', directory: true },
    { value: 'z directory/', label: 'z directory/', directory: true },
    { value: 'a file.txt', label: 'a file.txt', directory: false },
    { value: 'z file.txt', label: 'z file.txt', directory: false },
  ], truncated: false });
  const dot = await completePath({ prefix: './a', cwd });
  assert.deepEqual(dot.items.map(item => item.value), ['./a directory/', './a file.txt']);
  const absolute = await completePath({ prefix: `${cwd}/a` });
  assert.deepEqual(absolute.items.map(item => item.value), [`${cwd}/a directory/`, `${cwd}/a file.txt`]);
  const onlyDirectories = await completePath({ prefix: '', cwd, directoriesOnly: true });
  assert(onlyDirectories.items.every(item => item.directory));
  assert.equal(onlyDirectories.items.length, 2);
});

test('completion and attachments expand remote ~ and default relative paths to home', async t => {
  const cwd = await temporary(t);
  await writeFile(join(cwd, 'hello world.txt'), 'hello');
  const fromHome = relative(homedir(), cwd);
  const prefix = `~/${fromHome}/hello`;
  assert.deepEqual((await completePath({ prefix })).items.map(item => item.value), [`~/${fromHome}/hello world.txt`]);
  assert.equal((await readAttachment({ path: `${fromHome}/hello world.txt` })).text, 'hello');
  assert.equal((await readAttachment({ path: `~/${fromHome}/hello world.txt`, cwd: '/' })).text, 'hello');
  assert.deepEqual((await completePath({ prefix: 'hello', cwd: `~/${fromHome}` })).items.map(item => item.value), ['hello world.txt']);
  assert.deepEqual(await completePath({ prefix: '~someone/' }), { items: [], truncated: false });
});

test('completion handles symlinks and skips broken links and unsafe filenames', async t => {
  const cwd = await temporary(t);
  await mkdir(join(cwd, 'target'));
  await writeFile(join(cwd, 'plain'), 'text');
  await Promise.all([
    symlink('target', join(cwd, 'directory-link')), symlink('plain', join(cwd, 'file-link')),
    symlink('missing', join(cwd, 'broken')), symlink('loop', join(cwd, 'loop')),
    ...['bad\nname', 'bad\tname', 'bad\x1bname', 'bad\u2028name'].map(name => writeFile(join(cwd, name), '')),
  ]);
  const result = await completePath({ prefix: '', cwd });
  assert.deepEqual(result.items.map(item => item.value), ['directory-link/', 'target/', 'file-link', 'plain']);
  assert.equal((await completePath({ prefix: 'directory-link/', cwd })).items.length, 0);
  assert.equal((await readAttachment({ path: 'file-link', cwd })).text, 'text');
});

test('completion returns no matches for missing paths and rejects injection controls', async t => {
  const cwd = await temporary(t);
  assert.deepEqual(await completePath({ prefix: 'missing/', cwd }), { items: [], truncated: false });
  await assert.rejects(completePath({ prefix: 'bad\npath', cwd }), /control characters/);
  await assert.rejects(completePath({ prefix: '', cwd: '\x00' }), /control characters/);
  const name = '$(touch DO_NOT_CREATE); space';
  await writeFile(join(cwd, name), 'literal');
  assert.equal((await completePath({ prefix: '$', cwd })).items[0].value, name);
  assert.equal((await readAttachment({ path: name, cwd })).text, 'literal');
  await assert.rejects(readFile(join(cwd, 'DO_NOT_CREATE')), { code: 'ENOENT' });
});

test('completion caps returned matches and bounds directory scanning', async t => {
  const cwd = await temporary(t);
  // Batch creation to avoid exhausting the file descriptor limit.
  for (let start = 0; start <= MAX_DIRECTORY_ENTRIES; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, MAX_DIRECTORY_ENTRIES + 1 - start) }, (_, index) =>
      writeFile(join(cwd, `file-${String(start + index).padStart(5, '0')}`), '')));
  }
  const result = await completePath({ prefix: '', cwd });
  assert.equal(result.items.length, MAX_COMPLETION_ITEMS);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items.map(item => item.value), [...result.items.map(item => item.value)].sort());
  // Reaching the scan cap is signalled even when few/no items match.
  assert.equal((await completePath({ prefix: 'not-present', cwd })).truncated, true);
});

test('text attachments are exact UTF-8, including empty files and image-like extensions', async t => {
  const cwd = await temporary(t);
  const text = '\ufeffHello 🦊\nline two\r\n\ttab\u2028separator';
  await writeFile(join(cwd, 'not-an-image.png'), text);
  await writeFile(join(cwd, 'empty'), '');
  assert.deepEqual(await readAttachment({ path: 'not-an-image.png', cwd }), { path: join(cwd, 'not-an-image.png'), text });
  assert.deepEqual(await readAttachment({ path: 'empty', cwd }), { path: join(cwd, 'empty'), text: '' });
});

test('attachment type comes from supported image bytes rather than filename', async t => {
  const cwd = await temporary(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO0cAAAAASUVORK5CYII=', 'base64');
  for (const [mimeType, bytes] of [
    ['image/png', png], ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
    ['image/gif', Buffer.from('GIF89a')], ['image/webp', Buffer.from('RIFF0000WEBP')],
  ] as const) {
    await writeFile(join(cwd, 'image-without-extension'), bytes);
    assert.deepEqual(await readAttachment({ path: 'image-without-extension', cwd }), {
      path: join(cwd, 'image-without-extension'), image: { type: 'image', data: bytes.toString('base64'), mimeType },
    });
  }
  const bmp = Buffer.alloc(58); bmp.write('BM'); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  await writeFile(join(cwd, 'bmp'), bmp);
  assert.equal((await readAttachment({ path: 'bmp', cwd })).image?.mimeType, 'image/bmp');
});

test('attachments reject binary, invalid UTF-8, unsupported APNG, directories, FIFOs, and devices', async t => {
  const cwd = await temporary(t);
  for (const bytes of [Buffer.from([0]), Buffer.from([0xc3, 0x28]), Buffer.from('text\x1b[31m')]) {
    await writeFile(join(cwd, 'binary'), bytes);
    await assert.rejects(readAttachment({ path: 'binary', cwd }), /binary|UTF-8/);
  }
  const apng = Buffer.alloc(45); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(apng);
  apng.writeUInt32BE(13, 8); apng.write('IHDR', 12); apng.write('acTL', 37);
  await writeFile(join(cwd, 'animated.png'), apng);
  await assert.rejects(readAttachment({ path: 'animated.png', cwd }), /binary|UTF-8/);
  await assert.rejects(readAttachment({ path: cwd }), /regular files/);
  if (process.platform !== 'win32') {
    await execute('mkfifo', [join(cwd, 'pipe')]);
    await symlink('pipe', join(cwd, 'pipe-link'));
    await assert.rejects(readAttachment({ path: 'pipe', cwd }), /regular files/);
    await assert.rejects(readAttachment({ path: 'pipe-link', cwd }), /regular files/);
    await assert.rejects(readAttachment({ path: '/dev/null' }), /regular files/);
    assert.equal((await completePath({ prefix: 'pipe', cwd })).items.length, 0);
  }
});

test('text and image size limits accept exact boundaries and never silently truncate', async t => {
  const cwd = await temporary(t);
  await writeFile(join(cwd, 'text'), Buffer.alloc(MAX_TEXT_BYTES, 'x'));
  assert.equal((await readAttachment({ path: 'text', cwd })).text?.length, MAX_TEXT_BYTES);
  await writeFile(join(cwd, 'text'), Buffer.alloc(MAX_TEXT_BYTES + 1, 'x'));
  await assert.rejects(readAttachment({ path: 'text', cwd }), /1 MiB text/);
  const image = Buffer.alloc(MAX_IMAGE_BYTES); image.write('GIF89a');
  await writeFile(join(cwd, 'image'), image);
  assert.equal(Buffer.from((await readAttachment({ path: 'image', cwd })).image!.data, 'base64').length, MAX_IMAGE_BYTES);
  await writeFile(join(cwd, 'image'), Buffer.concat([image, Buffer.from([0])]));
  await assert.rejects(readAttachment({ path: 'image', cwd }), /8 MiB image/);
});

test('filesystem metadata reports unborn branches and omits detached or missing repositories', async t => {
  const root = await temporary(t);
  const cwd = join(root, 'repo $(touch NOT_EXECUTED)'); await mkdir(cwd);
  assert.deepEqual(await filesystemMetadata({ cwd }), { homeDir: homedir() });
  await execute('git', ['init', '-b', 'test-branch', cwd]);
  assert.deepEqual(await filesystemMetadata({ cwd }), { homeDir: homedir(), gitBranch: 'test-branch' });
  await execute('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--allow-empty', '-m', 'fixture'], { cwd });
  await execute('git', ['checkout', '--detach'], { cwd });
  assert.deepEqual(await filesystemMetadata({ cwd }), { homeDir: homedir() });
  await assert.rejects(readFile(join(cwd, 'NOT_EXECUTED')), { code: 'ENOENT' });
});

test('file dispatcher validates JSON params and is reusable without a daemon', async t => {
  const cwd = await temporary(t); await writeFile(join(cwd, 'file'), 'contents');
  assert.deepEqual(await serveFileRequest('read_attachment', { path: 'file', cwd }), { path: join(cwd, 'file'), text: 'contents' });
  assert.deepEqual(await serveFileRequest('complete_path', { prefix: '', cwd }), await completePath({ prefix: '', cwd }));
  assert.deepEqual(await serveFileRequest('filesystem_metadata', { cwd }), { homeDir: homedir() });
  await assert.rejects(serveFileRequest('other', {}), /Unknown file request/);
  await assert.rejects(serveFileRequest('read_attachment', {}), /path must/);
  await assert.rejects(serveFileRequest('complete_path', { prefix: '', directoriesOnly: 'yes' }), /boolean/);
  await assert.rejects(serveFileRequest('read_attachment', { path: 'file', cwd: 42 }), /cwd must/);
  await assert.rejects(readAttachment({ path: 'missing.txt', cwd }), error => {
    assert.match((error as Error).message, /Cannot attach "missing.txt".*ENOENT/);
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); return true;
  });
});
