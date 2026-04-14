// src/lib/minimatch-simple.js
//
// Minimal glob matcher. Supports: *, **, ?, [...], {a,b,c}

/**
 * Check if a path matches a glob pattern.
 */
export function minimatch(filePath, pattern) {
  if (!pattern || !filePath) return false;
  if (pattern === '*') return true;
  if (pattern === filePath) return true;

  const regex = globToRegex(pattern);
  return regex.test(filePath);
}

function globToRegex(pattern) {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        regex += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '{') {
      const closeIdx = pattern.indexOf('}', i);
      if (closeIdx > 0) {
        const options = pattern.slice(i + 1, closeIdx).split(',');
        regex += '(' + options.map(o => o.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = closeIdx + 1;
      } else {
        regex += '\\{';
        i++;
      }
    } else if (c === '.' || c === '(' || c === ')' || c === '+' || c === '|' || c === '^' || c === '$' || c === '\\') {
      regex += '\\' + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  return new RegExp('^' + regex + '$');
}
