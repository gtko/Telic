import { createHash } from 'node:crypto';
import type { D1Value } from './transform.ts';

/** Empreinte canonique d'une ligne : les mêmes valeurs D1 donnent toujours la même empreinte. */
export function rowSha256(values: D1Value[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Identifiant de clé comparable (valeurs D1 de la clé primaire). */
export function keyOf(values: D1Value[]): string {
  return JSON.stringify(values);
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) : même seed, même échantillon. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Échantillon uniforme de taille k (reservoir sampling), déterministe pour un seed donné. */
export class Reservoir<T> {
  private readonly items: T[] = [];
  private seen = 0;
  private readonly random: () => number;

  constructor(
    private readonly k: number,
    seed: number,
  ) {
    this.random = mulberry32(seed);
  }

  offer(item: T): void {
    if (this.k <= 0) return;
    if (this.items.length < this.k) {
      this.items.push(item);
    } else {
      const j = Math.floor(this.random() * (this.seen + 1));
      if (j < this.k) this.items[j] = item;
    }
    this.seen++;
  }

  sample(): T[] {
    return [...this.items];
  }
}
