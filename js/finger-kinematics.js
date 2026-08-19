/**
 * finger-kinematics.js — Finger Flexion & Strike Posture Analysis
 *
 * Computes relative flexion angles at each finger joint using the
 * MediaPipe hand landmark topology:
 *
 *   Wrist(0) → MCP(base) → PIP(mid) → DIP(distal) → Tip
 *
 * Purpose:
 *  - Distinguish actual "finger curl + strike" from whole-hand translation
 *  - Whole-hand movement does NOT change inter-joint angles
 *  - Only genuine finger flexion/extension triggers angle changes
 *
 * Each finger returns:
 *  - mcpAngle: angle at MCP joint (Wrist-MCP-PIP)
 *  - pipAngle: angle at PIP joint (MCP-PIP-DIP)
 *  - dipAngle: angle at DIP joint (PIP-DIP-Tip)
 *  - totalFlexion: weighted sum representing overall curl degree
 *  - tipToMcpRatio: tip-to-MCP distance relative to fully extended estimate
 */

/**
 * Joint landmark indices for each finger in MediaPipe hand topology
 */
export const FINGER_JOINTS = {
  Thumb:  { wrist: 0, cmc: 1, mcp: 2, ip: 3, tip: 4 },
  Index:  { wrist: 0, mcp: 5, pip: 6, dip: 7, tip: 8 },
  Middle: { wrist: 0, mcp: 9, pip: 10, dip: 11, tip: 12 },
  Ring:   { wrist: 0, mcp: 13, pip: 14, dip: 15, tip: 16 },
  Pinky:  { wrist: 0, mcp: 17, pip: 18, dip: 19, tip: 20 }
};

/**
 * Compute angle (in degrees) between two 3D vectors originating from a common point
 * @param {{ x: number, y: number, z: number }} a First endpoint
 * @param {{ x: number, y: number, z: number }} b Common vertex (joint)
 * @param {{ x: number, y: number, z: number }} c Second endpoint
 * @returns {number} Angle in degrees [0, 180]
 */
function angleBetween3Points(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };

  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y + ba.z * ba.z);
  const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);

  if (magBA < 1e-8 || magBC < 1e-8) return 180; // Degenerate case

  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.acos(cosAngle) * (180 / Math.PI);
}

/**
 * Compute distance between two 3D points
 */
function distance3D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export class FingerKinematics {
  constructor() {
    // Store previous frame flexion data for delta computation
    this._prevFlexion = new Map(); // fingerKey → { totalFlexion, timestamp }
  }

  /**
   * Compute flexion data for a single non-thumb finger
   * @param {Array} landmarks Full 21-landmark array from MediaPipe
   * @param {string} fingerName 'Index' | 'Middle' | 'Ring' | 'Pinky'
   * @returns {Object} Flexion data
   */
  computeFlexion(landmarks, fingerName) {
    if (fingerName === 'Thumb') {
      return this.computeThumbFlexion(landmarks);
    }

    const joints = FINGER_JOINTS[fingerName];
    if (!joints) return null;

    const wrist = landmarks[joints.wrist];
    const mcp = landmarks[joints.mcp];
    const pip = landmarks[joints.pip];
    const dip = landmarks[joints.dip];
    const tip = landmarks[joints.tip];

    // Joint angles (180° = straight/extended, smaller = more curled)
    const mcpAngle = angleBetween3Points(wrist, mcp, pip);
    const pipAngle = angleBetween3Points(mcp, pip, dip);
    const dipAngle = angleBetween3Points(pip, dip, tip);

    // Total flexion: how much the finger is curled
    // 180° at each joint = fully straight → totalFlexion = 0
    // Weighted: PIP contributes most to visible curling
    const mcpFlexion = 180 - mcpAngle;
    const pipFlexion = 180 - pipAngle;
    const dipFlexion = 180 - dipAngle;
    const totalFlexion = mcpFlexion * 0.3 + pipFlexion * 0.5 + dipFlexion * 0.2;

    // Tip-to-MCP distance ratio (normalized by MCP-to-wrist distance for scale invariance)
    const tipToMcp = distance3D(tip, mcp);
    const mcpToWrist = distance3D(mcp, wrist);
    const tipToMcpRatio = mcpToWrist > 1e-6 ? tipToMcp / mcpToWrist : 1;

    return {
      fingerName,
      mcpAngle,
      pipAngle,
      dipAngle,
      mcpFlexion,
      pipFlexion,
      dipFlexion,
      totalFlexion,
      tipToMcpRatio
    };
  }

  /**
   * Compute flexion for the thumb (different joint topology)
   * Thumb: CMC(1) → MCP(2) → IP(3) → Tip(4)
   */
  computeThumbFlexion(landmarks) {
    const joints = FINGER_JOINTS.Thumb;
    const wrist = landmarks[joints.wrist];
    const cmc = landmarks[joints.cmc];
    const mcp = landmarks[joints.mcp];
    const ip = landmarks[joints.ip];
    const tip = landmarks[joints.tip];

    const cmcAngle = angleBetween3Points(wrist, cmc, mcp);
    const mcpAngle = angleBetween3Points(cmc, mcp, ip);
    const ipAngle = angleBetween3Points(mcp, ip, tip);

    const cmcFlexion = 180 - cmcAngle;
    const mcpFlexion = 180 - mcpAngle;
    const ipFlexion = 180 - ipAngle;
    const totalFlexion = cmcFlexion * 0.2 + mcpFlexion * 0.5 + ipFlexion * 0.3;

    const tipToBase = distance3D(tip, cmc);
    const baseToWrist = distance3D(cmc, wrist);
    const tipToMcpRatio = baseToWrist > 1e-6 ? tipToBase / baseToWrist : 1;

    return {
      fingerName: 'Thumb',
      mcpAngle: cmcAngle,
      pipAngle: mcpAngle,
      dipAngle: ipAngle,
      mcpFlexion: cmcFlexion,
      pipFlexion: mcpFlexion,
      dipFlexion: ipFlexion,
      totalFlexion,
      tipToMcpRatio
    };
  }

  /**
   * Determine if the finger is in a strike-appropriate posture
   * Requires minimum flexion to distinguish from flat/extended hand hovering
   *
   * @param {Object} flexionData Output from computeFlexion
   * @param {Object} thresholds
   * @param {number} [thresholds.minTotalFlexion=15] Minimum total flexion degrees for strike
   * @param {number} [thresholds.maxTipToMcpRatio=2.5] Maximum tip-to-MCP distance ratio
   * @returns {boolean}
   */
  isStrikePosture(flexionData, thresholds = {}) {
    if (!flexionData) return false;

    const minFlexion = thresholds.minTotalFlexion !== undefined ? thresholds.minTotalFlexion : 15;
    const maxRatio = thresholds.maxTipToMcpRatio !== undefined ? thresholds.maxTipToMcpRatio : 2.5;

    // Finger must be at least somewhat curled
    const hasFlexion = flexionData.totalFlexion >= minFlexion;

    // Tip must not be too far from MCP (would indicate fully extended finger pointing away)
    const tipCloseEnough = flexionData.tipToMcpRatio <= maxRatio;

    return hasFlexion || tipCloseEnough;
  }

  /**
   * Compute flexion velocity (rate of change of totalFlexion)
   * Useful for detecting the "curling acceleration" during a strike
   *
   * @param {string} fingerKey Unique finger identifier
   * @param {Object} flexionData Current flexion data
   * @param {number} timestamp Current time in ms
   * @returns {number} Flexion velocity in degrees/second (positive = curling more)
   */
  computeFlexionVelocity(fingerKey, flexionData, timestamp) {
    const prev = this._prevFlexion.get(fingerKey);
    let velocity = 0;

    if (prev && flexionData) {
      const dt = (timestamp - prev.timestamp) / 1000;
      if (dt > 0.005 && dt < 0.5) {
        velocity = (flexionData.totalFlexion - prev.totalFlexion) / dt;
      }
    }

    if (flexionData) {
      this._prevFlexion.set(fingerKey, {
        totalFlexion: flexionData.totalFlexion,
        timestamp
      });
    }

    return velocity;
  }

  /**
   * Compute all 5 fingers' flexion data at once
   * @param {Array} landmarks Full 21-landmark array
   * @returns {Object} Map of fingerName → flexion data
   */
  computeAllFingers(landmarks) {
    const result = {};
    for (const name of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      result[name] = this.computeFlexion(landmarks, name);
    }
    return result;
  }

  /**
   * Clean up tracking for fingers no longer detected
   * @param {Set<string>} activeKeys Currently active finger keys
   */
  cleanup(activeKeys) {
    for (const key of this._prevFlexion.keys()) {
      if (!activeKeys.has(key)) {
        this._prevFlexion.delete(key);
      }
    }
  }
}
