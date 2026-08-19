/**
 * one-euro-filter.js — Adaptive Low-Pass Filter (1€ Filter)
 *
 * Reference: Géry Casiez, Nicolas Roussel, Daniel Vogel.
 * "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
 * CHI 2012.
 *
 * Key properties:
 *  - High-speed motion → raises cutoff frequency → low latency (tracks fast movements)
 *  - Low-speed / stationary → lowers cutoff frequency → high smoothing (removes jitter)
 *  - Automatic adaptation per-frame, no manual switching needed
 *
 * Parameters:
 *  - freq:      Sampling frequency (Hz), typically 30 for 30fps camera
 *  - minCutoff: Minimum cutoff frequency (Hz). Lower = more smoothing when stationary. Default: 1.0
 *  - beta:      Speed coefficient. Higher = less lag during fast movement. Default: 0.007
 *  - dCutoff:   Cutoff frequency for derivative filter. Default: 1.0
 */

/**
 * Low-pass filter with exponential smoothing
 */
class LowPassFilter {
  constructor(alpha, initVal = 0) {
    this.y = initVal;
    this.s = initVal;
    this.a = alpha;
    this.initialized = false;
  }

  /**
   * @param {number} value Raw input
   * @param {number} alpha Smoothing factor (0..1). Higher = less smoothing.
   * @returns {number} Filtered output
   */
  filter(value, alpha) {
    if (!this.initialized) {
      this.s = value;
      this.initialized = true;
      return value;
    }
    this.a = alpha;
    this.s = alpha * value + (1 - alpha) * this.s;
    return this.s;
  }

  lastValue() {
    return this.s;
  }

  reset() {
    this.initialized = false;
    this.s = 0;
  }
}

/**
 * Single-axis 1€ Filter
 */
export class OneEuroFilter {
  /**
   * @param {number} freq      Expected sampling frequency (Hz)
   * @param {number} minCutoff Minimum cutoff frequency (lower = more smoothing at rest)
   * @param {number} beta      Speed coefficient (higher = more responsive to fast movement)
   * @param {number} dCutoff   Derivative cutoff frequency
   */
  constructor(freq = 30, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;

    this.xFilter = new LowPassFilter(this._alpha(minCutoff));
    this.dxFilter = new LowPassFilter(this._alpha(dCutoff), 0);
    this.lastTime = -1;
    this.initialized = false;
  }

  /**
   * Compute smoothing factor alpha from cutoff frequency
   * @param {number} cutoff Cutoff frequency in Hz
   * @returns {number} Alpha (0..1)
   */
  _alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  /**
   * Filter a single value
   * @param {number} x     Raw input value
   * @param {number} [timestamp] Timestamp in seconds (optional, auto-increments if omitted)
   * @returns {number} Filtered value
   */
  filter(x, timestamp) {
    if (this.lastTime >= 0 && timestamp !== undefined) {
      const dt = timestamp - this.lastTime;
      if (dt > 0 && dt < 1.0) {
        this.freq = 1.0 / dt;
      }
    }
    this.lastTime = timestamp !== undefined ? timestamp : this.lastTime + 1.0 / this.freq;

    // Estimate derivative (speed)
    const prevX = this.xFilter.lastValue();
    const dx = this.initialized ? (x - prevX) * this.freq : 0;
    this.initialized = true;

    // Filter the derivative
    const edx = this.dxFilter.filter(dx, this._alpha(this.dCutoff));

    // Adaptive cutoff: faster movement → higher cutoff → less smoothing
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);

    // Filter the signal with adaptive alpha
    return this.xFilter.filter(x, this._alpha(cutoff));
  }

  /**
   * Reset filter state (e.g. when hand is lost and reappears)
   */
  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = -1;
    this.initialized = false;
  }

  /**
   * Update parameters at runtime (from debug panel)
   */
  setParams({ minCutoff, beta, dCutoff }) {
    if (minCutoff !== undefined) this.minCutoff = minCutoff;
    if (beta !== undefined) this.beta = beta;
    if (dCutoff !== undefined) this.dCutoff = dCutoff;
  }
}

/**
 * 3-axis (x, y, z) landmark filter using 1€ Filter
 * Apply to each fingertip for jitter-free, low-latency tracking
 */
export class LandmarkFilter {
  /**
   * @param {Object} [options]
   * @param {number} [options.freq=30]
   * @param {number} [options.minCutoff=1.0]
   * @param {number} [options.beta=0.007]
   * @param {number} [options.dCutoff=1.0]
   */
  constructor(options = {}) {
    const freq = options.freq || 30;
    const minCutoff = options.minCutoff || 1.0;
    const beta = options.beta || 0.007;
    const dCutoff = options.dCutoff || 1.0;

    this.filterX = new OneEuroFilter(freq, minCutoff, beta, dCutoff);
    this.filterY = new OneEuroFilter(freq, minCutoff, beta, dCutoff);
    this.filterZ = new OneEuroFilter(freq, minCutoff, beta, dCutoff);
  }

  /**
   * Filter a 3D landmark point
   * @param {{ x: number, y: number, z: number }} landmark
   * @param {number} timestamp Timestamp in seconds
   * @returns {{ x: number, y: number, z: number }} Filtered landmark
   */
  filter(landmark, timestamp) {
    return {
      x: this.filterX.filter(landmark.x, timestamp),
      y: this.filterY.filter(landmark.y, timestamp),
      z: this.filterZ.filter(landmark.z !== undefined ? landmark.z : 0, timestamp)
    };
  }

  /**
   * Reset all axis filters
   */
  reset() {
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
  }

  /**
   * Update parameters on all axes at runtime
   */
  setParams(params) {
    this.filterX.setParams(params);
    this.filterY.setParams(params);
    this.filterZ.setParams(params);
  }
}

/**
 * Manager for filtering all 21 hand landmarks (or subset) per hand
 * Typically used for 5 fingertips per hand → 10 total
 */
export class HandLandmarkFilterManager {
  /**
   * @param {Object} [options] Filter options
   */
  constructor(options = {}) {
    this.options = {
      freq: options.freq || 30,
      minCutoff: options.minCutoff || 1.0,
      beta: options.beta || 0.007,
      dCutoff: options.dCutoff || 1.0
    };
    // Map: fingerKey → LandmarkFilter
    // fingerKey format: "${handedness}_${landmarkIndex}" e.g. "Left_8"
    this.filters = new Map();
  }

  /**
   * Get or create a filter for a specific finger
   * @param {string} fingerKey Unique key for the finger
   * @returns {LandmarkFilter}
   */
  getFilter(fingerKey) {
    if (!this.filters.has(fingerKey)) {
      this.filters.set(fingerKey, new LandmarkFilter(this.options));
    }
    return this.filters.get(fingerKey);
  }

  /**
   * Filter a landmark for a specific finger
   * @param {string} fingerKey
   * @param {{ x: number, y: number, z: number }} landmark
   * @param {number} timestamp Timestamp in seconds
   * @returns {{ x: number, y: number, z: number }}
   */
  filterLandmark(fingerKey, landmark, timestamp) {
    return this.getFilter(fingerKey).filter(landmark, timestamp);
  }

  /**
   * Remove filters for fingers no longer tracked
   * @param {Set<string>} activeKeys Currently active finger keys
   */
  cleanup(activeKeys) {
    for (const key of this.filters.keys()) {
      if (!activeKeys.has(key)) {
        this.filters.delete(key);
      }
    }
  }

  /**
   * Update filter parameters globally
   * @param {Object} params { minCutoff, beta, dCutoff }
   */
  setParams(params) {
    if (params.minCutoff !== undefined) this.options.minCutoff = params.minCutoff;
    if (params.beta !== undefined) this.options.beta = params.beta;
    if (params.dCutoff !== undefined) this.options.dCutoff = params.dCutoff;

    for (const filter of this.filters.values()) {
      filter.setParams(params);
    }
  }

  /**
   * Clear all filter state
   */
  resetAll() {
    this.filters.clear();
  }
}
