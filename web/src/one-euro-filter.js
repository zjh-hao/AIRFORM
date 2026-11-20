// Casiez, Roussel & Vogel, CHI 2012. Scalar filtering in metric units.
// Uses only past/current input; it never fills missing data.
export class OneEuroFilter {
  constructor({ minCutoff = 1.5, beta = 4, derivativeCutoff = 1 } = {}) {
    if (![minCutoff, beta, derivativeCutoff].every(Number.isFinite)
        || minCutoff <= 0 || beta < 0 || derivativeCutoff <= 0) throw new Error('Invalid filter settings');
    Object.assign(this, { minCutoff, beta, derivativeCutoff });
    this.reset();
  }
  reset() { this.previous = null; }
  filter(value, timestamp) {
    if (!Number.isFinite(value) || !Number.isFinite(timestamp)) return null;
    const previous = this.previous;
    if (previous && timestamp <= previous.timestamp) return null;
    if (!previous) {
      this.previous = { value, filtered: value, derivative: 0, timestamp };
      return value;
    }
    const dt = (timestamp - previous.timestamp) / 1000;
    const alpha = cutoff => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const rawDerivative = (value - previous.value) / dt;
    const derivative = previous.derivative + alpha(this.derivativeCutoff) * (rawDerivative - previous.derivative);
    const filtered = previous.filtered + alpha(this.minCutoff + this.beta * Math.abs(derivative)) * (value - previous.filtered);
    this.previous = { value, filtered, derivative, timestamp };
    return filtered;
  }
}
