/** Compiles literal names or bounded wildcard alternatives; no user regular expressions. */
function nameMatcher(value = '', mode = 'auto', sensitive = false) {
  if (!['auto', 'contains', 'exact', 'wildcard'].includes(mode))
    throw Error('Choose a valid name matching option.');
  const text = String(value).trim();
  if (text.length > 240) throw Error('Keep the name filter under 240 characters.');
  const normalize = (s) => (sensitive ? s : s.toLowerCase());
  if (!text) return () => true;
  const terms =
    mode === 'contains' || mode === 'exact'
      ? [text]
      : text
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean);
  if (!terms.length || terms.length > 20)
    throw Error('Use between 1 and 20 name patterns, separated by |.');
  const checks = terms.map((term) => {
    let selected = mode;
    if (selected === 'auto')
      selected =
        term.startsWith('"') && term.endsWith('"')
          ? 'exact'
          : /[*?]/.test(term)
            ? 'wildcard'
            : 'contains';
    if (term.startsWith('"') && term.endsWith('"')) term = term.slice(1, -1);
    term = normalize(term);
    if (selected === 'contains') return (name) => name.includes(term);
    if (selected === 'exact') return (name) => name === term;
    // Greedy glob matching bounds memory and avoids regular-expression backtracking.
    return (name) => {
      let p = 0,
        n = 0,
        star = -1,
        retry = 0;
      while (n < name.length) {
        if (term[p] === '?' || term[p] === name[n]) {
          p++;
          n++;
        } else if (term[p] === '*') {
          star = p++;
          retry = n;
        } else if (star !== -1) {
          p = star + 1;
          n = ++retry;
        } else return false;
      }
      while (term[p] === '*') p++;
      return p === term.length;
    };
  });
  return (name) => checks.some((check) => check(normalize(name)));
}
module.exports = { nameMatcher };
