/** Keeps application history independent of renderer URLs and serializes transitions. */
function createNavigation(transition) {
  let entries = ['home'],
    index = 0,
    busy = false,
    generation = 0;
  async function run(id, next) {
    if (busy) return false;
    if (id === entries[index]) return true;
    busy = true;
    const revision = generation;
    try {
      if (!(await transition(id)) || revision !== generation) return false;
      if (next === undefined) {
        entries = entries.slice(0, index + 1);
        entries.push(id);
        if (entries.length > 32) entries.shift();
        index = entries.length - 1;
      } else index = next;
      return true;
    } finally {
      busy = false;
    }
  }
  return {
    open: (id) => run(id),
    go(direction) {
      if (direction !== 'back' && direction !== 'forward') return Promise.resolve(false);
      const next = index + (direction === 'back' ? -1 : direction === 'forward' ? 1 : 0);
      return next < 0 || next >= entries.length ? Promise.resolve(false) : run(entries[next], next);
    },
    reset() {
      entries = ['home'];
      index = 0;
      generation++;
    },
    state: () => ({
      current: entries[index],
      back: index > 0,
      forward: index < entries.length - 1,
      busy,
    }),
  };
}
module.exports = { createNavigation };
