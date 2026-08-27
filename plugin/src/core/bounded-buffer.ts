/** Appends to a buffer, evicting the oldest entry first once it's at
 * capacity — mutates `buffer` in place. Shared by memory.ts's transcript
 * and reflection.ts's failures/messages buffers, which all hand-rolled
 * the identical "if full, shift; then push" pattern independently. */
export function pushBounded<T>(buffer: T[], item: T, max: number): void {
  if (buffer.length >= max) buffer.shift();
  buffer.push(item);
}
