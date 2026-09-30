import {
  STRATEGY_WEIGHTS,
  Scored,
  applySticky,
  fnv1a,
  scoreCandidates,
} from './routing-score';
import type { RouteMetrics } from './routing-metrics.service';

function mm(p: Partial<RouteMetrics> = {}): RouteMetrics {
  return {
    ok: 0,
    fail: 0,
    r429: 0,
    latSum: 0,
    latN: 0,
    slow: 0,
    slowTotal: 0,
    outSum: 0,
    outN: 0,
    valid: 0,
    inval: 0,
    refuse: 0,
    dayReq: 0,
    dayTok: 0,
    cf: 0,
    cdexp: 0,
    open: false,
    halfOpen: false,
    ...p,
  };
}

const base = { weight: 1, qualityScore: 1 };

function sc(score: number): Scored {
  return {
    score,
    terms: { price: 0.5, speed: 0.5, stability: 0.5, quality: 0.5, noise: 0.5 },
  };
}

describe('scoreCandidates', () => {
  it('falls back to ascending cost when there are no metrics', () => {
    const s = scoreCandidates(
      [
        { id: 'exp', cost: 5, ...base },
        { id: 'cheap', cost: 1, ...base },
      ],
      'BALANCED',
    );
    expect(s.get('cheap')!.score).toBeGreaterThan(s.get('exp')!.score);
  });

  it('ranks unknown-cost candidates last', () => {
    const s = scoreCandidates(
      [
        { id: 'unknown', cost: Number.POSITIVE_INFINITY, ...base },
        { id: 'known', cost: 3, ...base },
      ],
      'BALANCED',
    );
    expect(s.get('known')!.score).toBeGreaterThan(s.get('unknown')!.score);
  });

  it('gives neutral price score when every cost is unknown (no discrimination)', () => {
    const s = scoreCandidates(
      [
        { id: 'a', cost: Number.POSITIVE_INFINITY, ...base },
        { id: 'b', cost: Number.POSITIVE_INFINITY, ...base },
      ],
      'BALANCED',
    );
    expect(s.get('a')!.terms.price).toBeCloseTo(0.5, 9);
    expect(s.get('b')!.terms.price).toBeCloseTo(0.5, 9);
  });

  it('every strategy weight set sums to 1', () => {
    for (const [, w] of Object.entries(STRATEGY_WEIGHTS)) {
      const sum = w.price + w.speed + w.stability + w.quality + w.noise;
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it('STABLE ranks the reliable channel first', () => {
    const s = scoreCandidates(
      [
        { id: 'sick', cost: 1, ...base, metrics: mm({ ok: 0, fail: 10 }) },
        { id: 'healthy', cost: 1, ...base, metrics: mm({ ok: 10, fail: 0 }) },
      ],
      'STABLE',
    );
    expect(s.get('healthy')!.terms.stability).toBeGreaterThan(
      s.get('sick')!.terms.stability,
    );
    expect(s.get('healthy')!.score).toBeGreaterThan(s.get('sick')!.score);
  });

  it('FASTEST ranks the low-latency channel first', () => {
    const s = scoreCandidates(
      [
        { id: 'slow', cost: 1, ...base, metrics: mm({ latN: 10, latSum: 100000 }) },
        { id: 'fast', cost: 1, ...base, metrics: mm({ latN: 10, latSum: 2000 }) },
      ],
      'FASTEST',
    );
    expect(s.get('fast')!.score).toBeGreaterThan(s.get('slow')!.score);
  });

  it('CHEAPEST tolerates a slow but cheap channel', () => {
    const s = scoreCandidates(
      [
        { id: 'fast-exp', cost: 10, ...base, metrics: mm({ latN: 10, latSum: 2000 }) },
        { id: 'slow-cheap', cost: 1, ...base, metrics: mm({ latN: 10, latSum: 100000 }) },
      ],
      'CHEAPEST',
    );
    expect(s.get('slow-cheap')!.score).toBeGreaterThan(s.get('fast-exp')!.score);
  });

  it('QUALITY_FIRST follows the L1 manual quality score', () => {
    const s = scoreCandidates(
      [
        { id: 'suspect', cost: 1, weight: 1, qualityScore: 0.5 },
        { id: 'good', cost: 1, weight: 1, qualityScore: 1 },
      ],
      'QUALITY_FIRST',
    );
    expect(s.get('good')!.terms.quality).toBeGreaterThan(s.get('suspect')!.terms.quality);
    expect(s.get('good')!.score).toBeGreaterThan(s.get('suspect')!.score);
  });

  it('penalized candidates get exactly 0.1x the score', () => {
    const input = { id: 'x', cost: 2, ...base, metrics: mm({ ok: 10 }) };
    const plain = scoreCandidates([{ ...input }], 'BALANCED').get('x')!;
    const penal = scoreCandidates([{ ...input, penalized: true }], 'BALANCED').get('x')!;
    expect(penal.score).toBeCloseTo(plain.score * 0.1, 10);
  });

  it('heavier weight wins the noise term (gumbel race)', () => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.9);
    try {
      const s = scoreCandidates(
        [
          { id: 'light', cost: 1, weight: 1, qualityScore: 1 },
          { id: 'heavy', cost: 1, weight: 10, qualityScore: 1 },
        ],
        'BALANCED',
      );
      expect(s.get('heavy')!.terms.noise).toBeGreaterThan(s.get('light')!.terms.noise);
      expect(s.get('heavy')!.score).toBeGreaterThan(s.get('light')!.score);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns empty map for empty input', () => {
    expect(scoreCandidates([], 'BALANCED').size).toBe(0);
  });
});

describe('fnv1a', () => {
  it('is stable and unsigned', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).toBeGreaterThanOrEqual(0);
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});

describe('applySticky', () => {
  const mk = (id: string, tier = 1, priority = 0) => ({ id, tier, priority });
  const scores = (...pairs: [string, number][]) =>
    new Map(pairs.map(([id, s]) => [id, sc(s)]));
  const keyWithIdx = (mod: number, idx: number) => {
    for (let i = 0; i < 500; i++) {
      const k = `k${i}`;
      if (idx !== 0 && fnv1a(k) % mod === idx) return k;
    }
    throw new Error('no key found');
  };

  it('moves the preferred same-group candidate to the front', () => {
    const ranked = [mk('a'), mk('b'), mk('c')];
    const s = scores(['a', 1], ['b', 1], ['c', 1]);
    const key = keyWithIdx(3, 1);
    const hit = applySticky(ranked, s, key, 0.8);
    expect(hit).not.toBeNull();
    expect(ranked[0]).toBe(hit);
    expect(ranked.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not stick a candidate below the score ratio', () => {
    const ranked = [mk('a'), mk('b')];
    const s = scores(['a', 1], ['b', 0.5]);
    const key = keyWithIdx(2, 1);
    expect(applySticky(ranked, s, key, 0.8)).toBeNull();
    expect(ranked[0].id).toBe('a');
  });

  it('does not cross priority boundaries (single-candidate group)', () => {
    const ranked = [mk('a', 1, 10), mk('b', 1, 0)];
    const s = scores(['a', 1], ['b', 1]);
    expect(applySticky(ranked, s, keyWithIdx(2, 1), 0.8)).toBeNull();
    expect(ranked.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns null for fewer than two candidates', () => {
    expect(applySticky([mk('a')], scores(['a', 1]), 'any', 0.8)).toBeNull();
  });
});
