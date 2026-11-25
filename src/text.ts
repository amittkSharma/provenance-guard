/** `plural(1, 'package')` → `1 package`; `plural(2, 'dependency', 'dependencies')` → `2 dependencies`. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** At most five items, then `+N more`. */
export const shortList = (items: string[]) =>
  items.length > 5 ? `${items.slice(0, 5).join(', ')} +${items.length - 5} more` : items.join(', ');

export const packageId = ({ name, version }: { name: string; version: string }) => `${name}@${version}`;

/** Escapes text for HTML and XML. Every value from a lockfile or the registry is attacker-controllable. */
export const escapeMarkup = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
