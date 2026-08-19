/**
 * homography.js — Projective Geometry Transform for Keyboard Plane Mapping
 *
 * Computes a 3×3 homography matrix H from the 4-corner keyboard quad,
 * enabling bidirectional mapping between:
 *   - Screen coordinates (sx, sy) in normalized [0..1] space
 *   - Keyboard UV coordinates (u, v) where u ∈ [0,1] (left→right), v ∈ [0,1] (top→bottom)
 *
 * This corrects perspective distortion from angled/oblique camera placement,
 * ensuring uniform key hit detection across the entire keyboard regardless of
 * how the camera views the paper keyboard.
 *
 * Algorithm: Direct Linear Transform (DLT) with 4-point correspondences
 */

export class HomographyTransform {
  constructor() {
    // Forward matrix: screen → keyboard UV
    this.H = null;
    // Inverse matrix: keyboard UV → screen
    this.Hinv = null;
    // Cache the quad used to compute H (to detect changes)
    this._cachedQuadHash = '';
  }

  /**
   * Compute homography matrix from keyboard quad corners
   * Maps quad corners to unit square: TL→(0,0), TR→(1,0), BR→(1,1), BL→(0,1)
   *
   * @param {{ topLeft: {x,y}, topRight: {x,y}, bottomRight: {x,y}, bottomLeft: {x,y} }} quad
   */
  computeFromQuad(quad) {
    const hash = this._hashQuad(quad);
    if (hash === this._cachedQuadHash && this.H) {
      return; // No change, skip recomputation
    }

    // Source points (screen coordinates from quad)
    const src = [
      [quad.topLeft.x, quad.topLeft.y],
      [quad.topRight.x, quad.topRight.y],
      [quad.bottomRight.x, quad.bottomRight.y],
      [quad.bottomLeft.x, quad.bottomLeft.y]
    ];

    // Destination points (unit square UV)
    const dst = [
      [0, 0],  // topLeft → UV origin
      [1, 0],  // topRight
      [1, 1],  // bottomRight
      [0, 1]   // bottomLeft
    ];

    this.H = this._computeHomography(src, dst);
    this.Hinv = this._computeHomography(dst, src);
    this._cachedQuadHash = hash;
  }

  /**
   * Transform screen coordinate to keyboard UV coordinate
   * @param {number} sx Screen x (normalized 0..1)
   * @param {number} sy Screen y (normalized 0..1)
   * @returns {{ u: number, v: number } | null} Keyboard UV, or null if H not computed
   */
  transform(sx, sy) {
    if (!this.H) return null;
    return this._applyHomography(this.H, sx, sy);
  }

  /**
   * Transform keyboard UV coordinate back to screen coordinate
   * @param {number} u Keyboard U (0..1, left→right)
   * @param {number} v Keyboard V (0..1, top→bottom)
   * @returns {{ x: number, y: number } | null} Screen coordinate, or null if Hinv not computed
   */
  inverseTransform(u, v) {
    if (!this.Hinv) return null;
    return this._applyHomography(this.Hinv, u, v);
  }

  /**
   * Check if a UV point is within the keyboard bounds (with optional margin)
   * @param {number} u
   * @param {number} v
   * @param {number} [margin=0.02] Allow slight overshoot
   * @returns {boolean}
   */
  isInKeyboardBounds(u, v, margin = 0.02) {
    return u >= -margin && u <= 1 + margin && v >= -margin && v <= 1 + margin;
  }

  /**
   * Apply homography matrix to a 2D point
   * @param {number[]} H 3×3 matrix as flat array [h0..h8]
   * @param {number} x
   * @param {number} y
   * @returns {{ u: number, v: number } | { x: number, y: number }}
   */
  _applyHomography(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    if (Math.abs(w) < 1e-10) return { u: 0, v: 0, x: 0, y: 0 };

    const px = (H[0] * x + H[1] * y + H[2]) / w;
    const py = (H[3] * x + H[4] * y + H[5]) / w;

    return { u: px, v: py, x: px, y: py };
  }

  /**
   * Compute 3×3 homography matrix using Direct Linear Transform (DLT)
   * Solves for H such that dst = H * src for each of the 4 point correspondences
   *
   * @param {number[][]} src Array of 4 source points [[x,y], ...]
   * @param {number[][]} dst Array of 4 destination points [[x,y], ...]
   * @returns {number[]} Flat 3×3 matrix [h0, h1, ..., h8]
   */
  _computeHomography(src, dst) {
    // Build the 8×9 matrix A for the DLT equations
    // Each point correspondence gives 2 equations:
    //   -x*h0 - y*h1 - h2 + 0 + 0 + 0 + x*x'*h6 + y*x'*h7 + x'*h8 = 0
    //   0 + 0 + 0 - x*h3 - y*h4 - h5 + x*y'*h6 + y*y'*h7 + y'*h8 = 0
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [sx, sy] = src[i];
      const [dx, dy] = dst[i];

      A.push([
        -sx, -sy, -1, 0, 0, 0, sx * dx, sy * dx, dx
      ]);
      A.push([
        0, 0, 0, -sx, -sy, -1, sx * dy, sy * dy, dy
      ]);
    }

    // Solve using SVD-like approach for 4-point case
    // Since we have exactly 8 equations for 9 unknowns (up to scale),
    // we use Gaussian elimination to find the null space
    const h = this._solveHomographySystem(A);

    return h;
  }

  /**
   * Solve the homography linear system Ah = 0
   * Uses Gaussian elimination with partial pivoting to find the null vector
   *
   * @param {number[][]} A 8×9 matrix
   * @returns {number[]} 9-element homography vector
   */
  _solveHomographySystem(A) {
    const m = 8;
    const n = 9;

    // Create augmented copy
    const M = A.map(row => [...row]);

    // Gaussian elimination with partial pivoting
    for (let col = 0; col < m; col++) {
      // Find pivot
      let maxVal = Math.abs(M[col][col]);
      let maxRow = col;
      for (let row = col + 1; row < m; row++) {
        if (Math.abs(M[row][col]) > maxVal) {
          maxVal = Math.abs(M[row][col]);
          maxRow = row;
        }
      }

      // Swap rows
      if (maxRow !== col) {
        [M[col], M[maxRow]] = [M[maxRow], M[col]];
      }

      // Eliminate below
      const pivot = M[col][col];
      if (Math.abs(pivot) < 1e-12) continue;

      for (let row = col + 1; row < m; row++) {
        const factor = M[row][col] / pivot;
        for (let j = col; j < n; j++) {
          M[row][j] -= factor * M[col][j];
        }
      }
    }

    // Back substitution: set h[8] = 1 (homography is defined up to scale)
    const h = new Array(n).fill(0);
    h[n - 1] = 1;

    for (let row = m - 1; row >= 0; row--) {
      let sum = 0;
      let pivotCol = -1;

      for (let col = 0; col < n; col++) {
        if (pivotCol === -1 && Math.abs(M[row][col]) > 1e-12) {
          pivotCol = col;
        } else if (pivotCol >= 0) {
          sum += M[row][col] * h[col];
        }
      }

      if (pivotCol >= 0 && Math.abs(M[row][pivotCol]) > 1e-12) {
        h[pivotCol] = -sum / M[row][pivotCol];
      }
    }

    return h;
  }

  /**
   * Create a hash string from quad corners for change detection
   * @param {Object} quad
   * @returns {string}
   */
  _hashQuad(quad) {
    const p = (v) => `${v.x.toFixed(6)},${v.y.toFixed(6)}`;
    return `${p(quad.topLeft)}|${p(quad.topRight)}|${p(quad.bottomRight)}|${p(quad.bottomLeft)}`;
  }
}
