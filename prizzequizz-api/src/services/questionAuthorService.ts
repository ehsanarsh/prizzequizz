/* WHO WROTE THIS QUESTION.
 *
 * «در موقع پخش سوال باید ریز زیر سوال بنویسه: طراحی شده توسط …»
 *
 * A question a player wrote carries `source_ref = 'player:<userId>'` — that is
 * how the panel knows who to pay when it approves one. This turns that into the
 * name to print under the question while it is being asked, so the person who
 * wrote it is credited every time it is played, not only on the day it was
 * accepted.
 *
 * Questions written by the operator or generated have no author and return an
 * empty string, which is the signal to print nothing at all rather than a
 * line with a blank in it.
 */
import { repositories } from '../repositories/index.js';

/* Names change rarely and a question can be asked to twenty people at once, so
 * the lookup is remembered. Bounded, because an unbounded cache on a long-lived
 * process is a leak with a nicer name. */
const cache = new Map<string, string>();
const MAX = 500;

function authorIdOf(q: any): string {
  const ref = String(q?.source_ref ?? q?.sourceRef ?? '');
  return ref.startsWith('player:') ? ref.slice(7).trim() : '';
}

/** The display name to credit, or '' when nobody wrote it by hand. */
export async function authorNameFor(q: any): Promise<string> {
  const userId = authorIdOf(q);
  if (!userId) return '';
  const hit = cache.get(userId);
  if (hit !== undefined) return hit;
  let name = '';
  try {
    const u = await repositories.users.findById(userId);
    name = String(u?.displayName || u?.username || '').trim();
  } catch { name = ''; }
  if (cache.size >= MAX) cache.clear();
  cache.set(userId, name);
  return name;
}

/** Add `authorName` to a question shape that is about to go to a client. */
export async function withAuthor<T extends object>(view: T, q: any): Promise<T & { authorName: string }> {
  return Object.assign(view, { authorName: await authorNameFor(q) });
}

/** Test seam. */
export function _resetAuthorCache(): void { cache.clear(); }
