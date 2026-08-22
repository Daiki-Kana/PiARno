/**
 * keystroke-analyzer.js - 37-Key Paper Piano: Composite Kinematics & Adaptive Collision Engine
 *
 * OVERHAULED: Integrates 4 approaches for robust keystroke detection:
 *  1. One Euro Filter — adaptive jitter removal with low-latency tracking
 *  2. Homography Transform — perspective-corrected keyboard UV coordinates
 *  3. Finger Kinematics — flexion angle analysis to distinguish strikes from hand motion
 *  4. 4-State Machine — IDLE → DOWNWARD → TRIGGER → COOLDOWN per finger
 *
 * Replaces the previous simple "Y coordinate + velocity threshold" approach.
 */

import { FINGER_INDICES, FINGER_NAMES } from './hand-tracker.js';
import { WHITE_KEYS, BLACK_KEYS } from './synth.js';
import { HandLandmarkFilterManager } from './one-euro-filter.js';
import { HomographyTransform } from './homography.js';
import { FingerKinematics } from './finger-kinematics.js';

/**
 * Finger state machine states
 */
const STATE = {
  IDLE: 'IDLE',           // Floating or stationary above keyboard
  DOWNWARD: 'DOWNWARD',   // Moving downward with sufficient velocity + flexion
  TRIGGER: 'TRIGGER',     // Deceleration/reversal detected → Note On fires HERE
  COOLDOWN: 'COOLDOWN'    // Post-trigger lock until finger lifts sufficiently
};

export class KeystrokeAnalyzer {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    // 1. Keyboard Quad Geometry (Normalized 0..1 coordinates)
    const savedQuad = this.loadSavedQuad();
    this.keyboardQuad = savedQuad || {
      topLeft:     { x: 0.04, y: 0.40 },
      topRight:    { x: 0.96, y: 0.40 },
      bottomRight: { x: 0.96, y: 0.62 },
      bottomLeft:  { x: 0.04, y: 0.62 }
    };

    // 2. Touch Height Threshold & Hysteresis
    const savedTouchY = parseFloat(localStorage.getItem('ar_piano_touch_y_v3'));
    this.touchThresholdY = !isNaN(savedTouchY) ? savedTouchY : 0.56;

    // 3. Tunable Parameters (can be updated by DebugPanel)
    this.params = {
      hysteresisMargin: 0.025,
      downwardVelocityThreshold: 0.12,
      decelerationRatio: 0.5,
      flexionThreshold: 15,
      flexionEnabled: true,
      cooldownLiftAmount: 0.03,
      cooldownTimeMs: 80,
      filterMinCutoff: 1.0,
      filterBeta: 0.007,
      useRoiCrop: true,
    };

    // 4. Ring buffer of recent fingertip Y positions for calibration
    this.touchSampleHistory = [];
    this.maxSampleHistory = 50;

    // 5. State tracking per finger (2 hands × 5 fingers = up to 10)
    // Key format: `${handedness}_${fingerIndex}` (e.g. "Left_8", "Right_12")
    this.fingerStates = new Map();

    // 6. Active Key highlights for rendering
    this.activeKeyHighlights = new Map();

    // 7. Event listeners
    this.listeners = {
      noteOn: [],
      noteOff: []
    };

    // 8. Subsystem instances
    this.landmarkFilterManager = new HandLandmarkFilterManager({
      freq: 30,
      minCutoff: this.params.filterMinCutoff,
      beta: this.params.filterBeta,
      dCutoff: 1.0
    });

    this.homography = new HomographyTransform();
    this.kinematics = new FingerKinematics();

    // 9. Recompute homography from current quad
    this._updateHomography();
  }

  // ─── Quad persistence ──────────────────────────────────────────

  loadSavedQuad() {
    try {
      const data = localStorage.getItem('ar_piano_quad_v3') || localStorage.getItem('ar_piano_quad_v2');
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.topLeft && parsed.topRight && parsed.bottomRight && parsed.bottomLeft) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Could not load saved keyboard quad', e);
    }
    return null;
  }

  saveQuad() {
    try {
      localStorage.setItem('ar_piano_quad_v3', JSON.stringify(this.keyboardQuad));
      localStorage.setItem('ar_piano_touch_y_v3', this.touchThresholdY.toString());
    } catch (e) {
      console.warn('Could not save keyboard quad', e);
    }
    this._updateHomography();
  }

  resetQuad() {
    this.keyboardQuad = {
      topLeft:     { x: 0.04, y: 0.40 },
      topRight:    { x: 0.96, y: 0.40 },
      bottomRight: { x: 0.96, y: 0.62 },
      bottomLeft:  { x: 0.04, y: 0.62 }
    };
    this.touchThresholdY = 0.56;
    this.saveQuad();
  }

  _updateHomography() {
    this.homography.computeFromQuad(this.keyboardQuad);
  }

  // ─── Event system ──────────────────────────────────────────────

  onNoteOn(callback) {
    this.listeners.noteOn.push(callback);
  }

  onNoteOff(callback) {
    this.listeners.noteOff.push(callback);
  }

  emitNoteOn(event) {
    for (const cb of this.listeners.noteOn) {
      try { cb(event); } catch (err) { console.error('Error in noteOn callback', err); }
    }
  }

  emitNoteOff(event) {
    for (const cb of this.listeners.noteOff) {
      try { cb(event); } catch (err) { console.error('Error in noteOff callback', err); }
    }
  }

  // ─── Parameter update (from DebugPanel) ────────────────────────

  updateParams(newParams) {
    Object.assign(this.params, newParams);

    // Propagate filter params
    this.landmarkFilterManager.setParams({
      minCutoff: this.params.filterMinCutoff,
      beta: this.params.filterBeta
    });
  }

  // ─── Calibration ──────────────────────────────────────────────

  /**
   * Register desk contact plane using multi-frame sampling & outlier rejection
   */
  calibrateTouchHeight(currentRawHands = []) {
    const samples = [];

    if (currentRawHands && currentRawHands.length > 0) {
      for (const hand of currentRawHands) {
        for (const idx of FINGER_INDICES) {
          const tip = hand.landmarks[idx];
          if (tip && typeof tip.y === 'number') {
            samples.push(tip.y);
          }
        }
      }
    }

    for (const y of this.touchSampleHistory) {
      samples.push(y);
    }

    if (samples.length === 0) return null;

    samples.sort((a, b) => a - b);
    const trimCount = Math.floor(samples.length * 0.15);
    const startIdx = trimCount;
    const endIdx = samples.length - trimCount;

    let sumY = 0;
    let count = 0;
    for (let i = startIdx; i < endIdx; i++) {
      sumY += samples[i];
      count++;
    }

    if (count > 0) {
      this.touchThresholdY = sumY / count;
      this.saveQuad();
      return this.touchThresholdY;
    }

    return null;
  }

  // ─── Spatial hit testing ──────────────────────────────────────

  /**
   * Compute keyboard bounding box ROI in normalized [0..1] space with configurable margin
   * @param {number} [margin=0.10]
   * @returns {{ minX: number, minY: number, maxX: number, maxY: number, width: number, height: number }}
   */
  getKeyboardRoi(margin = 0.10) {
    const q = this.keyboardQuad;
    const minX = Math.max(0, Math.min(q.topLeft.x, q.bottomLeft.x) - margin);
    const maxX = Math.min(1, Math.max(q.topRight.x, q.bottomRight.x) + margin);
    const minY = Math.max(0, Math.min(q.topLeft.y, q.topRight.y) - margin * 1.5); // extra headroom for descending fingers
    const maxY = Math.min(1, Math.max(q.bottomLeft.y, q.bottomRight.y) + margin);
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  isPointInQuad(px, py) {
    const quad = [
      this.keyboardQuad.topLeft,
      this.keyboardQuad.topRight,
      this.keyboardQuad.bottomRight,
      this.keyboardQuad.bottomLeft
    ];
    return this.isPointInPolygon(px, py, quad);
  }

  /**
   * Get key at normalized screen point with Black-over-White priority
   */
  getKeyAtPoint(px, py) {
    if (!this.isPointInQuad(px, py)) {
      return null;
    }

    const { topLeft: TL, topRight: TR, bottomRight: BR, bottomLeft: BL } = this.keyboardQuad;
    const NUM_WHITE = WHITE_KEYS.length;

    // 1. Black keys first (physically above white keys)
    for (let b = 0; b < BLACK_KEYS.length; b++) {
      const bk = BLACK_KEYS[b];
      const whiteIdx = bk.afterWhiteIndex;

      const tCenter = (whiteIdx + 1) / NUM_WHITE;
      const bkW = 0.58 / NUM_WHITE;
      const t0 = tCenter - bkW / 2;
      const t1 = tCenter + bkW / 2;
      const bkDepth = 0.58;

      const topL = { x: (1 - t0) * TL.x + t0 * TR.x, y: (1 - t0) * TL.y + t0 * TR.y };
      const topR = { x: (1 - t1) * TL.x + t1 * TR.x, y: (1 - t1) * TL.y + t1 * TR.y };

      const botFullL = (1 - t0) * BL.x + t0 * BR.x;
      const botFullY_L = (1 - t0) * BL.y + t0 * BR.y;
      const botFullR = (1 - t1) * BL.x + t1 * BR.x;
      const botFullY_R = (1 - t1) * BL.y + t1 * BR.y;

      const botL = { x: topL.x + (botFullL - topL.x) * bkDepth, y: topL.y + (botFullY_L - topL.y) * bkDepth };
      const botR = { x: topR.x + (botFullR - topR.x) * bkDepth, y: topR.y + (botFullY_R - topR.y) * bkDepth };

      if (this.isPointInPolygon(px, py, [topL, topR, botR, botL])) {
        return { isBlack: true, keyIndex: b, keyData: bk, keyId: `B_${b}` };
      }
    }

    // 2. White keys
    for (let k = 0; k < NUM_WHITE; k++) {
      const t0 = k / NUM_WHITE;
      const t1 = (k + 1) / NUM_WHITE;

      const pTL = { x: (1 - t0) * TL.x + t0 * TR.x, y: (1 - t0) * TL.y + t0 * TR.y };
      const pTR = { x: (1 - t1) * TL.x + t1 * TR.x, y: (1 - t1) * TL.y + t1 * TR.y };
      const pBR = { x: (1 - t1) * BL.x + t1 * BR.x, y: (1 - t1) * BL.y + t1 * BR.y };
      const pBL = { x: (1 - t0) * BL.x + t0 * BR.x, y: (1 - t0) * BL.y + t0 * BR.y };

      if (this.isPointInPolygon(px, py, [pTL, pTR, pBR, pBL])) {
        return { isBlack: false, keyIndex: k, keyData: WHITE_KEYS[k], keyId: `W_${k}` };
      }
    }

    return null;
  }

  isPointInPolygon(px, py, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, yi = polygon[i].y;
      const xj = polygon[j].x, yj = polygon[j].y;
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ─── Main Analysis (per frame) ────────────────────────────────

  /**
   * Main composite analysis: Filter → Homography → Kinematics → State Machine
   * @param {Array<Object>} rawHands Output from HandTracker
   * @returns {Array<Object>} Analyzed hands with enriched finger data
   */
  analyze(rawHands) {
    const now = performance.now();
    const timeSec = now / 1000;

    if (!rawHands || rawHands.length === 0) {
      this.checkGlobalReleases(now);
      return [];
    }

    const analyzedHands = [];
    const activeFingerKeysThisFrame = new Set();

    // Buffer fingertip Y positions for calibration
    for (const hand of rawHands) {
      for (const idx of FINGER_INDICES) {
        const tip = hand.landmarks[idx];
        if (tip && typeof tip.y === 'number') {
          this.touchSampleHistory.push(tip.y);
          if (this.touchSampleHistory.length > this.maxSampleHistory) {
            this.touchSampleHistory.shift();
          }
        }
      }
    }

    for (let h = 0; h < rawHands.length; h++) {
      const hand = rawHands[h];
      const analyzedFingers = {};

      // ── Kinematics: compute flexion for all fingers on this hand ──
      const allFlexion = this.kinematics.computeAllFingers(hand.landmarks);

      for (let f = 0; f < FINGER_NAMES.length; f++) {
        const fingerName = FINGER_NAMES[f];
        const tipIndex = FINGER_INDICES[f];
        const rawTip = hand.landmarks[tipIndex];
        const fingerKey = `${hand.handedness}_${tipIndex}`;
        activeFingerKeysThisFrame.add(fingerKey);

        // ── 1. One Euro Filter: smooth the fingertip coordinates ──
        const filteredTip = this.landmarkFilterManager.filterLandmark(fingerKey, rawTip, timeSec);

        // ── 2. Get or create finger state ──
        let fState = this.fingerStates.get(fingerKey);
        if (!fState) {
          fState = {
            key: fingerKey,
            handedness: hand.handedness,
            fingerName,
            tipIndex,
            smState: STATE.IDLE,       // State machine state
            activeKeyInfo: null,
            prevFilteredY: filteredTip.y,
            prevTime: now,
            velocityY: 0,
            peakVelocityY: 0,          // Track peak velocity during DOWNWARD phase
            lastStrikeTime: 0,
            touchProgress: 0,
            totalFlexion: 0,
            flexionVelocity: 0
          };
          this.fingerStates.set(fingerKey, fState);
        }

        // ── 3. Velocity computation (from filtered coordinates) ──
        const dt = (now - fState.prevTime) / 1000;
        let vy = 0;
        if (dt > 0.005) {
          vy = (filteredTip.y - fState.prevFilteredY) / dt;
          fState.velocityY = vy;
          fState.prevFilteredY = filteredTip.y;
          fState.prevTime = now;
        }

        // ── 4. Kinematics: flexion data ──
        const flexion = allFlexion[fingerName];
        if (flexion) {
          fState.totalFlexion = flexion.totalFlexion;
          fState.flexionVelocity = this.kinematics.computeFlexionVelocity(fingerKey, flexion, now);
        }

        // ── 5. Identify key under fingertip (using filtered position) ──
        const hitKey = this.getKeyAtPoint(filteredTip.x, filteredTip.y);

        // ── 6. Touch progress (0: above keyboard, 1: at touch plane) ──
        const quadTopY = (this.keyboardQuad.topLeft.y + this.keyboardQuad.topRight.y) / 2;
        const progressRange = Math.max(0.01, this.touchThresholdY - quadTopY);
        const touchProgress = Math.min(1.2, Math.max(0, (filteredTip.y - quadTopY) / progressRange));
        fState.touchProgress = touchProgress;

        // ── 7. Kinematics gate ──
        const flexionOk = !this.params.flexionEnabled ||
          !flexion ||
          this.kinematics.isStrikePosture(flexion, {
            minTotalFlexion: this.params.flexionThreshold
          });

        // ── 8. State Machine Transition ──
        this._updateStateMachine(fState, filteredTip, hitKey, vy, flexionOk, now, hand);

        analyzedFingers[fingerName] = {
          tip: filteredTip,
          rawTip,
          hitKey,
          isDown: fState.smState === STATE.TRIGGER || fState.smState === STATE.COOLDOWN,
          velocityY: fState.velocityY,
          touchProgress: fState.touchProgress,
          smState: fState.smState,
          totalFlexion: fState.totalFlexion,
          flexionVelocity: fState.flexionVelocity,
          flexionData: flexion
        };
      }

      analyzedHands.push({
        handedness: hand.handedness,
        handIndex: hand.handIndex,
        score: hand.score,
        landmarks: hand.landmarks,
        fingers: analyzedFingers
      });
    }

    // Clean up inactive fingers
    for (const [key, state] of this.fingerStates.entries()) {
      if (!activeFingerKeysThisFrame.has(key)) {
        if ((state.smState === STATE.TRIGGER || state.smState === STATE.COOLDOWN) && state.activeKeyInfo) {
          this.emitNoteOff({
            keyId: state.activeKeyInfo.keyId,
            isBlack: state.activeKeyInfo.isBlack,
            keyIndex: state.activeKeyInfo.keyIndex,
            keyData: state.activeKeyInfo.keyData,
            handedness: state.handedness,
            fingerName: state.fingerName,
            timestamp: now
          });
        }
        this.fingerStates.delete(key);
      }
    }

    // Clean up filter instances for disappeared fingers
    this.landmarkFilterManager.cleanup(activeFingerKeysThisFrame);
    this.kinematics.cleanup(activeFingerKeysThisFrame);

    // Clean expired key highlights (after 250ms)
    for (const [kId, hl] of this.activeKeyHighlights.entries()) {
      if (now - hl.startTime > 250) {
        this.activeKeyHighlights.delete(kId);
      }
    }

    return analyzedHands;
  }

  // ─── 4-State Machine ─────────────────────────────────────────

  /**
   * Per-finger state machine: IDLE → DOWNWARD → TRIGGER → COOLDOWN → IDLE
   */
  _updateStateMachine(fState, filteredTip, hitKey, vy, flexionOk, now, hand) {
    const p = this.params;

    switch (fState.smState) {

      case STATE.IDLE: {
        // Transition: IDLE → DOWNWARD
        // Conditions: moving downward fast enough AND finger has appropriate flexion
        const isMovingDown = vy >= p.downwardVelocityThreshold;
        const isPastTopOfKeyboard = filteredTip.y >= (this.keyboardQuad.topLeft.y + this.keyboardQuad.topRight.y) / 2 - 0.05;

        if (isMovingDown && flexionOk && isPastTopOfKeyboard) {
          fState.smState = STATE.DOWNWARD;
          fState.peakVelocityY = vy;
        }
        break;
      }

      case STATE.DOWNWARD: {
        // Track peak velocity during descent
        if (vy > fState.peakVelocityY) {
          fState.peakVelocityY = vy;
        }

        // Transition: DOWNWARD → TRIGGER
        // Conditions: velocity has decelerated significantly (zero-cross or ratio drop)
        // OR finger has reversed direction (going up)
        const hasDecelerated = fState.peakVelocityY > 0 &&
          vy < fState.peakVelocityY * p.decelerationRatio;
        const hasReversed = vy <= 0;
        const isPastTouchPlane = filteredTip.y >= (this.touchThresholdY - 0.02);
        const isCooldownElapsed = (now - fState.lastStrikeTime) > p.cooldownTimeMs;

        if ((hasDecelerated || hasReversed) && isPastTouchPlane && hitKey && isCooldownElapsed) {
          // ═══ TRIGGER: Fire Note On ═══
          fState.smState = STATE.TRIGGER;
          fState.activeKeyInfo = hitKey;
          fState.lastStrikeTime = now;

          const strikeVel = Math.min(1.0, Math.max(0.25, fState.peakVelocityY * 1.5));

          this.activeKeyHighlights.set(hitKey.keyId, {
            startTime: now,
            velocity: strikeVel,
            handedness: hand.handedness,
            fingerName: fState.fingerName,
            isBlack: hitKey.isBlack,
            keyIndex: hitKey.keyIndex,
            keyData: hitKey.keyData
          });

          this.emitNoteOn({
            keyId: hitKey.keyId,
            isBlack: hitKey.isBlack,
            keyIndex: hitKey.keyIndex,
            keyData: hitKey.keyData,
            note: hitKey.keyData.note,
            freq: hitKey.keyData.freq,
            velocity: strikeVel,
            handedness: hand.handedness,
            fingerName: fState.fingerName,
            tipPos: { x: filteredTip.x, y: filteredTip.y },
            timestamp: now
          });

          // Immediately transition to COOLDOWN
          fState.smState = STATE.COOLDOWN;
        }

        // Transition: DOWNWARD → IDLE (descent aborted)
        // If velocity drops below threshold without triggering
        if (vy < p.downwardVelocityThreshold * 0.3 && !hasDecelerated && !hasReversed) {
          fState.smState = STATE.IDLE;
          fState.peakVelocityY = 0;
        }

        break;
      }

      case STATE.TRIGGER: {
        // This state is transient — immediately moves to COOLDOWN in the same frame
        // (handled above in DOWNWARD → TRIGGER transition)
        fState.smState = STATE.COOLDOWN;
        break;
      }

      case STATE.COOLDOWN: {
        // Transition: COOLDOWN → IDLE
        // Conditions: finger has lifted sufficiently above touch plane
        const liftThreshold = this.touchThresholdY - p.cooldownLiftAmount;
        const hasLifted = filteredTip.y < liftThreshold;
        const hasLiftedAboveHysteresis = filteredTip.y < (this.touchThresholdY - p.hysteresisMargin);

        if (hasLifted || hasLiftedAboveHysteresis || !hitKey) {
          const prevKeyInfo = fState.activeKeyInfo;
          fState.smState = STATE.IDLE;
          fState.peakVelocityY = 0;
          fState.activeKeyInfo = null;

          if (prevKeyInfo) {
            this.emitNoteOff({
              keyId: prevKeyInfo.keyId,
              isBlack: prevKeyInfo.isBlack,
              keyIndex: prevKeyInfo.keyIndex,
              keyData: prevKeyInfo.keyData,
              handedness: fState.handedness,
              fingerName: fState.fingerName,
              timestamp: now
            });
          }
        }
        break;
      }
    }
  }

  // ─── Global release ───────────────────────────────────────────

  checkGlobalReleases(now) {
    for (const [key, state] of this.fingerStates.entries()) {
      if ((state.smState === STATE.TRIGGER || state.smState === STATE.COOLDOWN) && state.activeKeyInfo) {
        this.emitNoteOff({
          keyId: state.activeKeyInfo.keyId,
          isBlack: state.activeKeyInfo.isBlack,
          keyIndex: state.activeKeyInfo.keyIndex,
          keyData: state.activeKeyInfo.keyData,
          handedness: state.handedness,
          fingerName: state.fingerName,
          timestamp: now
        });
      }
    }
    this.fingerStates.clear();
    this.landmarkFilterManager.resetAll();
  }

  // ─── Legacy API compatibility ─────────────────────────────────

  setSensitivity(sensitivity) {
    this.params.downwardVelocityThreshold = 0.30 - (sensitivity * 0.24);
    this.landmarkFilterManager.setParams({
      minCutoff: this.params.filterMinCutoff,
      beta: this.params.filterBeta
    });
  }

  setTouchThreshold(val) {
    this.touchThresholdY = Math.max(0.1, Math.min(0.98, val));
    this.saveQuad();
  }

  setHysteresis(val) {
    this.params.hysteresisMargin = Math.max(0.005, Math.min(0.08, val));
  }
}
