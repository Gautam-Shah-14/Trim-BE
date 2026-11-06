/** Tiny Prometheus text-format registry (no dependency). Counters, gauges (callbacks) and one histogram family. */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15];

type Labels = Record<string, string | number>;
const key = (name: string, labels?: Labels) =>
  labels && Object.keys(labels).length
    ? `${name}{${Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
    : name;

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number | Promise<number>>();
  private hist = new Map<string, { buckets: number[]; sum: number; count: number }>();

  inc(name: string, labels?: Labels, by = 1) {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  get(name: string, labels?: Labels): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }
  gauge(name: string, fn: () => number | Promise<number>) {
    this.gauges.set(name, fn);
  }
  observe(name: string, seconds: number, labels?: Labels) {
    const k = key(name, labels);
    let h = this.hist.get(k);
    if (!h) this.hist.set(k, (h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h!.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
  }

  async render(): Promise<string> {
    const out: string[] = [];
    for (const [k, v] of [...this.counters].sort()) out.push(`${k} ${v}`);
    for (const [name, fn] of this.gauges) {
      try {
        out.push(`${name} ${await fn()}`);
      } catch {
        /* skip broken gauge */
      }
    }
    for (const [k, h] of this.hist) {
      const i = k.indexOf('{');
      const name = i === -1 ? k : k.slice(0, i);
      const lbl = i === -1 ? '' : k.slice(i + 1, -1);
      const join = (extra: string) => `{${[lbl, extra].filter(Boolean).join(',')}}`;
      BUCKETS.forEach((b, idx) => out.push(`${name}_bucket${join(`le="${b}"`)} ${h.buckets[idx]}`));
      out.push(`${name}_bucket${join('le="+Inf"')} ${h.count}`, `${name}_sum${lbl ? `{${lbl}}` : ''} ${h.sum}`, `${name}_count${lbl ? `{${lbl}}` : ''} ${h.count}`);
    }
    return `${out.join('\n')}\n`;
  }
}
