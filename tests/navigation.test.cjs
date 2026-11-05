const test = require('node:test'),
  assert = require('node:assert/strict');
const { createNavigation } = require('../src/navigation.cjs');
test('Back and Forward restore tool history without navigating renderer URLs', async () => {
  const visited = [];
  const navigation = createNavigation(async (id) => {
    visited.push(id);
    return true;
  });
  await navigation.open('mp3');
  await navigation.open('home');
  await navigation.open('network');
  await navigation.go('back');
  assert.equal(navigation.state().current, 'home');
  await navigation.go('back');
  assert.equal(navigation.state().current, 'mp3');
  await navigation.go('forward');
  assert.equal(navigation.state().current, 'home');
  await navigation.go('forward');
  assert.equal(navigation.state().current, 'network');
  await navigation.go('back');
  await navigation.open('gif');
  assert.equal(await navigation.go('forward'), false);
  assert.deepEqual(visited, [
    'mp3',
    'home',
    'network',
    'home',
    'mp3',
    'home',
    'network',
    'home',
    'gif',
  ]);
});
test('failed transitions preserve history and duplicate native/DOM signals do not skip entries', async () => {
  let finish;
  let blocked = false;
  const navigation = createNavigation((id) =>
    id === 'broken'
      ? Promise.reject(Error('Fixture failure'))
      : blocked
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve(true),
  );
  await navigation.open('mp3');
  await navigation.open('home');
  await assert.rejects(navigation.open('broken'));
  assert.equal(navigation.state().current, 'home');
  blocked = true;
  const first = navigation.go('back');
  assert.equal(await navigation.go('back'), false);
  finish(true);
  await first;
  assert.equal(navigation.state().current, 'mp3');
  const opening = navigation.open('gif');
  navigation.reset();
  finish(true);
  assert.equal(await opening, false);
  assert.equal(navigation.state().current, 'home');
});
