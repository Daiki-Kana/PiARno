/**
 * renderer.js - 37-Key AR Piano Visualizer & Overlay Engine (Minimalist Monochrome Edition)
 * Features:
 *  - Full 37-Key / 22 White Keys + 15 Black Keys Perspective Quad Rendering (Clean Black & White)
 *  - Active Keystroke Highlights, Note Badges & Pure White Strike Waves
 *  - 4-Corner Draggable Calibration Handles & Minimalist Zero-Point Touch Height Guideline
 *  - Skeleton Camera Overlay hidden by default for unobstructed camera view
 *  - Real-time Toggleable Hand Skeleton & Joint Visualizer for Calibration/Debug
 */

import { HAND_CONNECTIONS, FINGER_INDICES, FINGER_NAMES } from './hand-tracker.js';
import { WHITE_KEYS, BLACK_KEYS } from './synth.js';

export const THEMES = {
  Left: {
    name: 'Left Hand',
    primary: '#ffffff',
    outerLine: 'rgba(255, 255, 255, 0.25)',
    accent: '#cccccc',
    highlightFill: 'rgba(255, 255, 255, 0.92)',
    tipRing: '#ffffff'
  },
  Right: {
    name: 'Right Hand',
    primary: '#ffffff',
    outerLine: 'rgba(255, 255, 255, 0.25)',
    accent: '#cccccc',
    highlightFill: 'rgba(255, 255, 255, 0.92)',
    tipRing: '#ffffff'
  },
  Default: {
    name: 'Hand',
    primary: '#ffffff',
    outerLine: 'rgba(255, 255, 255, 0.25)',
    accent: '#cccccc',
    highlightFill: 'rgba(255, 255, 255, 0.92)',
    tipRing: '#ffffff'
  }
};

/**
 * State Machine state → fingertip ring color mapping (Monochrome)
 */
const STATE_RING_COLORS = {
  'IDLE': null,
  'DOWNWARD': '#e0e0e0',
  'TRIGGER': '#ffffff',
  'COOLDOWN': '#666666'
};

export class HandRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.strikeRipples = [];
    this.showMetrics = true;
    this.showSkeleton = false; // Default: HIDE skeleton on camera view
    this.isCalibrating = false;
    this.activeCornerDrag = null; // 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft'

    // Cached coordinates to prevent GC churn
    this._pixelCache = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  }

  setShowSkeleton(enabled) {
    this.showSkeleton = !!enabled;
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  addStrikeRipple(x, y, color) {
    if (this.strikeRipples.length > 12) {
      this.strikeRipples.shift();
    }
    this.strikeRipples.push({
      x,
      y,
      radius: 6,
      maxRadius: 36,
      opacity: 0.9,
      color: color || '#ffffff'
    });
  }

  /**
   * Main Render Pass
   * @param {Object} params
   * @param {Array<Object>} params.analyzedHands
   * @param {Object} params.analyzer KeystrokeAnalyzer instance
   * @param {boolean} params.isMirrored
   */
  render({ analyzedHands, analyzer, isMirrored = false }) {
    this.clear();
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (width === 0 || height === 0) return;

    // 1. Draw 37-Key Paper Keyboard Overlay (Minimal Monochrome)
    if (analyzer && analyzer.keyboardQuad) {
      this.renderKeyboardQuad(analyzer, width, height);
    }

    // 2. Draw Touch Height Guideline (Minimal dashed line)
    if (analyzer) {
      this.renderTouchHeightLine(analyzer, width, height);
    }

    // 3. Draw Pure White Strike Ripples
    if (this.strikeRipples.length > 0) {
      this.renderRipples();
    }

    // 4. Draw Hand Skeletons & Fingertips (If enabled or when triggering ripple)
    if (analyzedHands && analyzedHands.length > 0) {
      for (let h = 0; h < analyzedHands.length; h++) {
        const hand = analyzedHands[h];
        const theme = THEMES[hand.handedness] || THEMES.Default;
        const lms = hand.landmarks;

        for (let i = 0; i < 21; i++) {
          const lm = lms[i];
          this._pixelCache[i].x = isMirrored ? (1 - lm.x) * width : lm.x * width;
          this._pixelCache[i].y = lm.y * height;
          this._pixelCache[i].z = lm.z;
        }

        // Trigger ripples on strike
        this.processFingertipStrikes(hand, this._pixelCache, theme);

        // Draw full skeleton bones, intermediate joints and tags ONLY when showSkeleton is enabled
        if (this.showSkeleton) {
          this.drawFastSkeleton(this._pixelCache, theme);
          this.drawFastJoints(this._pixelCache, theme);
          this.drawFastHandTag(hand, this._pixelCache[0], theme);
        }

        // Always draw fingertip points (minimalist monochrome dots)
        this.drawFastFingertips(hand, this._pixelCache, theme, analyzer, isMirrored, width, height);
      }
    }

    // 5. Draw 4-Corner Calibration Handles
    if (analyzer && analyzer.keyboardQuad) {
      this.renderCalibrationHandles(analyzer.keyboardQuad, width, height);
    }
  }

  /**
   * Process fingertip trigger events to generate subtle white strike ripples
   */
  processFingertipStrikes(hand, coords, theme) {
    if (!hand.fingers) return;
    for (let i = 0; i < 5; i++) {
      const tipIdx = FINGER_INDICES[i];
      const name = FINGER_NAMES[i];
      const fingerInfo = hand.fingers[name];
      if (fingerInfo && fingerInfo.smState === 'TRIGGER') {
        const p = coords[tipIdx];
        this.addStrikeRipple(p.x, p.y, '#ffffff');
      }
    }
  }

  /**
   * Render 22 White Keys + 15 Black Keys in Minimalist Monochrome
   */
  renderKeyboardQuad(analyzer, width, height) {
    const ctx = this.ctx;
    const { topLeft: TL, topRight: TR, bottomRight: BR, bottomLeft: BL } = analyzer.keyboardQuad;
    const NUM_WHITE = WHITE_KEYS.length; // 22 White Keys

    // Compute pixel corners
    const pTL = { x: TL.x * width, y: TL.y * height };
    const pTR = { x: TR.x * width, y: TR.y * height };
    const pBR = { x: BR.x * width, y: BR.y * height };
    const pBL = { x: BL.x * width, y: BL.y * height };

    ctx.save();

    // Keyboard background backdrop (Deep Semi-transparent Dark)
    ctx.beginPath();
    ctx.moveTo(pTL.x, pTL.y);
    ctx.lineTo(pTR.x, pTR.y);
    ctx.lineTo(pBR.x, pBR.y);
    ctx.lineTo(pBL.x, pBL.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(10, 10, 10, 0.5)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 1. Draw 22 White Keys (C3 to C6)
    for (let k = 0; k < NUM_WHITE; k++) {
      const t0 = k / NUM_WHITE;
      const t1 = (k + 1) / NUM_WHITE;

      const kTL = { x: (1 - t0) * pTL.x + t0 * pTR.x, y: (1 - t0) * pTL.y + t0 * pTR.y };
      const kTR = { x: (1 - t1) * pTL.x + t1 * pTR.x, y: (1 - t1) * pTL.y + t1 * pTR.y };
      const kBR = { x: (1 - t1) * pBL.x + t1 * pBR.x, y: (1 - t1) * pBL.y + t1 * pBR.y };
      const kBL = { x: (1 - t0) * pBL.x + t0 * pBR.x, y: (1 - t0) * pBL.y + t0 * pBR.y };

      const keyData = WHITE_KEYS[k];
      const highlight = analyzer.activeKeyHighlights.get(`W_${k}`);

      ctx.beginPath();
      ctx.moveTo(kTL.x, kTL.y);
      ctx.lineTo(kTR.x, kTR.y);
      ctx.lineTo(kBR.x, kBR.y);
      ctx.lineTo(kBL.x, kBL.y);
      ctx.closePath();

      if (highlight) {
        // Active White Key Strike Glow (High-contrast pure white fill)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Normal White Key
        ctx.fillStyle = keyData.isC ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
        ctx.fill();
        ctx.strokeStyle = keyData.isC ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = keyData.isC ? 1.5 : 1;
        ctx.stroke();
      }

      // Key Note Label
      const labelX = (kBL.x + kBR.x) / 2;
      const labelY = (kBL.y + kBR.y) / 2 - 8;

      ctx.font = keyData.isC ? 'bold 11px monospace' : '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = highlight ? '#000000' : (keyData.isC ? '#ffffff' : 'rgba(255, 255, 255, 0.7)');
      ctx.fillText(keyData.note, labelX, labelY);

      if (keyData.isC && !highlight) {
        // Minimal dot for octave C
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(labelX, labelY + 9, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Draw 15 Black Keys (Across 3 Octaves)
    for (let b = 0; b < BLACK_KEYS.length; b++) {
      const bk = BLACK_KEYS[b];
      const whiteIdx = bk.afterWhiteIndex;

      const tCenter = (whiteIdx + 1) / NUM_WHITE;
      const bkW = 0.58 / NUM_WHITE; // black key width ratio
      const t0 = tCenter - bkW / 2;
      const t1 = tCenter + bkW / 2;
      const bkDepth = 0.58; // black key length ratio

      // Top line
      const topL = { x: (1 - t0) * pTL.x + t0 * pTR.x, y: (1 - t0) * pTL.y + t0 * pTR.y };
      const topR = { x: (1 - t1) * pTL.x + t1 * pTR.x, y: (1 - t1) * pTL.y + t1 * pTR.y };

      // Bot line at depth
      const botFullL = (1 - t0) * pBL.x + t0 * pBR.x;
      const botFullY_L = (1 - t0) * pBL.y + t0 * pBR.y;
      const botFullR = (1 - t1) * pBL.x + t1 * pBR.x;
      const botFullY_R = (1 - t1) * pBL.y + t1 * pBR.y;

      const botL = { x: topL.x + (botFullL - topL.x) * bkDepth, y: topL.y + (botFullY_L - topL.y) * bkDepth };
      const botR = { x: topR.x + (botFullR - topR.x) * bkDepth, y: topR.y + (botFullY_R - topR.y) * bkDepth };

      const highlight = analyzer.activeKeyHighlights.get(`B_${b}`);

      ctx.beginPath();
      ctx.moveTo(topL.x, topL.y);
      ctx.lineTo(topR.x, topR.y);
      ctx.lineTo(botR.x, botR.y);
      ctx.lineTo(botL.x, botL.y);
      ctx.closePath();

      if (highlight) {
        // Active Black Key Strike Glow (Inverted pure white)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Note text inside black key
        const midX = (topL.x + topR.x + botR.x + botL.x) / 4;
        const midY = (topL.y + topR.y + botR.y + botL.y) / 4;
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#000000';
        ctx.fillText(bk.note, midX, midY);
      } else {
        // Normal Black Key (Solid Dark with Crisp Border)
        ctx.fillStyle = 'rgba(12, 12, 12, 0.96)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /**
   * Render Desk Contact Plane (Zero Point) Guideline in Minimalist White
   */
  renderTouchHeightLine(analyzer, width, height) {
    const ctx = this.ctx;
    const touchY = analyzer.touchThresholdY * height;
    const { topLeft: TL, topRight: TR } = analyzer.keyboardQuad;

    const x0 = TL.x * width;
    const x1 = TR.x * width;

    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'; // Minimal white dashed line
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(x0, touchY);
    ctx.lineTo(x1, touchY);
    ctx.stroke();

    // Minimal badge tag
    ctx.setLineDash([]);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(10, 10, 10, 0.85)';
    ctx.fillRect(x0 + 4, touchY - 14, 138, 14);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 4, touchY - 14, 138, 14);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`打鍵接触面 (Y: ${Math.round(analyzer.touchThresholdY * 100)}%)`, x0 + 8, touchY - 7);

    ctx.restore();
  }

  /**
   * Render 4-Corner Draggable Calibration Handles in Monochrome
   */
  renderCalibrationHandles(quad, width, height) {
    const ctx = this.ctx;
    const corners = [
      { id: 'topLeft', label: 'TL ↖', p: quad.topLeft },
      { id: 'topRight', label: 'TR ↗', p: quad.topRight },
      { id: 'bottomRight', label: 'BR ↘', p: quad.bottomRight },
      { id: 'bottomLeft', label: 'BL ↙', p: quad.bottomLeft }
    ];

    for (const c of corners) {
      const cx = c.p.x * width;
      const cy = c.p.y * height;
      const isDragging = this.activeCornerDrag === c.id;

      ctx.save();
      // Outer ring
      ctx.beginPath();
      ctx.arc(cx, cy, isDragging ? 16 : 12, 0, Math.PI * 2);
      ctx.strokeStyle = isDragging ? '#ffffff' : 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = isDragging ? 2.5 : 1.5;
      ctx.stroke();

      // Center handle dot
      ctx.beginPath();
      ctx.arc(cx, cy, isDragging ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // Corner label badge
      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = 'rgba(10, 10, 10, 0.85)';
      ctx.fillRect(cx - 16, cy - 22, 32, 12);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.strokeRect(cx - 16, cy - 22, 32, 12);

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.label, cx, cy - 16);

      ctx.restore();
    }
  }

  /**
   * Draw bone connection lines (When showSkeleton is ON)
   */
  drawFastSkeleton(coords, theme) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
      const conn = HAND_CONNECTIONS[i];
      const pA = coords[conn[0]];
      const pB = coords[conn[1]];
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
    }
    ctx.stroke();
  }

  /**
   * Draw intermediate finger joints (When showSkeleton is ON)
   */
  drawFastJoints(coords, theme) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.beginPath();
    for (let i = 0; i < 21; i++) {
      if (i !== 4 && i !== 8 && i !== 12 && i !== 16 && i !== 20) {
        const p = coords[i];
        ctx.moveTo(p.x + 2.5, p.y);
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  }

  /**
   * Draw fingertip points with minimalist monochrome styling
   * (Always displayed to show accurate touch position while bones remain hidden)
   */
  drawFastFingertips(hand, coords, theme, analyzer, isMirrored, width, height) {
    const ctx = this.ctx;

    for (let i = 0; i < 5; i++) {
      const tipIdx = FINGER_INDICES[i];
      const name = FINGER_NAMES[i];
      const p = coords[tipIdx];
      const fingerInfo = hand.fingers ? hand.fingers[name] : null;

      const smState = fingerInfo?.smState || 'IDLE';
      const isDown = fingerInfo?.isDown || false;
      const hitKey = fingerInfo?.hitKey;

      let ringRadius = 6 + (fingerInfo?.touchProgress || 0) * 3;
      let ringColor = 'rgba(255, 255, 255, 0.45)';
      let fillColor = '#ffffff';

      if (smState === 'TRIGGER' || (smState === 'COOLDOWN' && isDown)) {
        ringRadius = 13;
        ringColor = '#ffffff';
      } else if (smState === 'DOWNWARD') {
        ringRadius = 8;
        ringColor = 'rgba(255, 255, 255, 0.85)';
      }

      // Outer ring
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = smState === 'TRIGGER' ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Center core point
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();

      // Strike note popup badge if finger triggered
      if (isDown && hitKey && hitKey.keyData) {
        const note = hitKey.keyData.note;
        ctx.font = 'bold 11px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`• ${note}`, p.x + 10, p.y - 8);
      }
    }
  }

  drawFastHandTag(hand, wrist, theme) {
    const ctx = this.ctx;
    const text = `${hand.handedness.toUpperCase()} [${Math.round(hand.score * 100)}%]`;
    ctx.font = 'bold 9px sans-serif';

    const x = wrist.x - 25;
    const y = Math.min(wrist.y + 14, this.canvas.height - 8);

    ctx.fillStyle = 'rgba(10, 10, 10, 0.8)';
    ctx.fillRect(x - 4, y - 10, 60, 13);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.strokeRect(x - 4, y - 10, 60, 13);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  }

  renderRipples() {
    const ctx = this.ctx;
    for (let i = this.strikeRipples.length - 1; i >= 0; i--) {
      const rip = this.strikeRipples[i];
      rip.radius += 2;
      rip.opacity -= 0.06;

      if (rip.opacity <= 0 || rip.radius >= rip.maxRadius) {
        this.strikeRipples.splice(i, 1);
        continue;
      }

      ctx.strokeStyle = rip.color;
      ctx.globalAlpha = Math.max(0, rip.opacity);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(rip.x, rip.y, rip.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
  }
}
