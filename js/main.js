/**
 * main.js - 37-Key AR Piano Web Application (Fullscreen Minimal Edition)
 * Full 2-Stage Calibration (4-Corner Quad Dragging & 5s Timer Desk Touch Zero-Point)
 * Integrated: 1€ Filter, Homography, Kinematics, 4-State Machine, Debug Panel
 */

import { CameraManager } from './camera.js';
import { HandTracker } from './hand-tracker.js';
import { KeystrokeAnalyzer } from './keystroke-analyzer.js';
import { HandRenderer } from './renderer.js';
import { PianoSynth } from './synth.js';
import { DebugPanel } from './debug-panel.js';

class ARPianoApp {
  constructor() {
    // DOM Elements
    this.video = document.getElementById('webcam-video');
    this.canvas = document.getElementById('output-canvas');

    // Controls & Countdown UI
    this.btnCalibrateTouch = document.getElementById('btn-calibrate-touch');
    this.btnSwitchCamera = document.getElementById('btn-switch-camera');
    this.countdownOverlay = document.getElementById('countdown-overlay');
    this.countdownNumber = document.getElementById('countdown-number');
    this.btnCancelCountdown = document.getElementById('btn-cancel-countdown');
    this.calibToast = document.getElementById('calib-toast');

    // Calibration Timer State
    this.calibrationTimer = null;
    this.calibrationRemaining = 0;

    // Core Engine Instances (Target resolution: 1920x1440 4:3 full-sensor wide angle)
    this.camera = new CameraManager(this.video, {
      width: 1920,
      height: 1440,
      defaultFacingMode: 'environment',
      mirrored: false
    });
    this.tracker = new HandTracker({
      numHands: 2,
      minDetectionConfidence: 0.6,
      minPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    });
    this.analyzer = new KeystrokeAnalyzer();
    this.renderer = new HandRenderer(this.canvas);
    this.synth = new PianoSynth();

    // Debug Panel — inject styles and create panel
    DebugPanel.injectStyles();
    this.debugPanel = new DebugPanel({
      onParamsChange: (key, value, allParams) => {
        this.analyzer.updateParams(allParams);
      },
      onSkeletonToggle: (show) => {
        this.renderer.setShowSkeleton(show);
      }
    });

    // Apply initial debug panel params to analyzer & renderer
    this.analyzer.updateParams(this.debugPanel.getAll());
    this.renderer.setShowSkeleton(this.debugPanel.get('showSkeleton'));

    // App State
    this.isRunning = false;
    this.isModelReady = false;
    this.isProcessingFrame = false;
    this.lastRawHands = [];
    this.activeDragCorner = null;
    this.audioUnlocked = false;
  }

  async init() {
    this.setupEventListeners();
    this.setupQuadDragging();
    this.setupAudioUnlock();

    // Bind Note On / Strike Sound
    this.analyzer.onNoteOn((event) => {
      this.synth.playKey(event.keyData, event.velocity);
    });

    // Start Camera immediately & Load MediaPipe Model in parallel
    const cameraPromise = this.startCamera();
    const modelPromise = this.loadModel();

    await Promise.allSettled([cameraPromise, modelPromise]);
  }

  setupAudioUnlock() {
    const unlock = () => {
      if (!this.audioUnlocked) {
        this.synth.init();
        this.audioUnlocked = true;
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
    window.addEventListener('click', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  async startCamera() {
    try {
      await this.camera.start();
      this.syncCanvasSize();

      if (!this.isRunning) {
        this.isRunning = true;
        this.startPipelineLoop();
      }

      const camLabel = this.camera.getCurrentCameraLabel();
      this.showToast(`カメラ起動: ${camLabel}`);
    } catch (err) {
      console.error('Camera startup failed', err);
      this.showToast(`カメラ起動エラー: ${err.message || err}`);
    }
  }

  async loadModel() {
    try {
      await this.tracker.initialize((msg) => {
        // Optional status updates
      });
      this.isModelReady = true;
    } catch (err) {
      console.error('Model initialization error', err);
      this.showToast(`モデル読込エラー: ${err.message || err}`);
    }
  }

  syncCanvasSize() {
    const size = this.camera.getVideoSize();
    this.renderer.resize(size.width, size.height);
  }

  showToast(message) {
    if (!this.calibToast) return;
    this.calibToast.textContent = message;
    this.calibToast.classList.remove('hidden');
    this.calibToast.classList.add('show');
    setTimeout(() => {
      this.calibToast.classList.remove('show');
      setTimeout(() => this.calibToast.classList.add('hidden'), 350);
    }, 2800);
  }

  /**
   * Start 5-Second Calibration Timer
   */
  startCalibrationCountdown() {
    if (this.calibrationTimer) {
      this.cancelCalibrationCountdown();
    }

    this.calibrationRemaining = 5;
    if (this.countdownNumber) {
      this.countdownNumber.textContent = this.calibrationRemaining.toString();
    }
    if (this.countdownOverlay) {
      this.countdownOverlay.classList.add('show');
    }

    if (this.btnCalibrateTouch) {
      this.btnCalibrateTouch.disabled = true;
      this.btnCalibrateTouch.style.opacity = '0.6';
      this.btnCalibrateTouch.textContent = `計測中 (${this.calibrationRemaining}s)`;
    }

    // First Tick Sound
    try { this.synth.playCountdownTick(false); } catch (e) {}

    this.calibrationTimer = setInterval(() => {
      this.calibrationRemaining--;

      if (this.calibrationRemaining > 0) {
        if (this.countdownNumber) {
          this.countdownNumber.textContent = this.calibrationRemaining.toString();
        }
        if (this.btnCalibrateTouch) {
          this.btnCalibrateTouch.textContent = `計測中 (${this.calibrationRemaining}s)`;
        }
        try { this.synth.playCountdownTick(false); } catch (e) {}
      } else {
        // Countdown Complete!
        clearInterval(this.calibrationTimer);
        this.calibrationTimer = null;

        if (this.countdownOverlay) {
          this.countdownOverlay.classList.remove('show');
        }

        if (this.btnCalibrateTouch) {
          this.btnCalibrateTouch.disabled = false;
          this.btnCalibrateTouch.style.opacity = '1';
          this.btnCalibrateTouch.textContent = 'キャリブレーション (5s)';
        }

        try { this.synth.playCountdownTick(true); } catch (e) {}
        this.executeCalibration();
      }
    }, 1000);
  }

  cancelCalibrationCountdown() {
    if (this.calibrationTimer) {
      clearInterval(this.calibrationTimer);
      this.calibrationTimer = null;
    }
    if (this.countdownOverlay) {
      this.countdownOverlay.classList.remove('show');
    }
    if (this.btnCalibrateTouch) {
      this.btnCalibrateTouch.disabled = false;
      this.btnCalibrateTouch.style.opacity = '1';
      this.btnCalibrateTouch.textContent = 'キャリブレーション (5s)';
    }
    this.showToast('キャリブレーションをキャンセルしました');
  }

  executeCalibration() {
    const registeredY = this.analyzer.calibrateTouchHeight(this.lastRawHands);
    if (registeredY !== null) {
      this.showToast(`打鍵接触面 (ゼロ点) を登録: Y = ${Math.round(registeredY * 100)}%`);
    } else {
      this.showToast('指先が検出されませんでした。机上の鍵盤に指を置いてお試しください。');
    }
  }

  setupEventListeners() {
    if (this.btnStartApp) {
      this.btnStartApp.addEventListener('click', () => this.startCameraAndTracking());
      this.btnStartApp.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.startCameraAndTracking();
      });
    }

    if (this.btnRetryInit) {
      this.btnRetryInit.addEventListener('click', () => this.loadModel());
    }

    // Touch Height Calibration (5s Timer)
    if (this.btnCalibrateTouch) {
      const handleCalibStart = (e) => {
        if (e) e.preventDefault();
        this.startCalibrationCountdown();
      };
      this.btnCalibrateTouch.addEventListener('click', handleCalibStart);
      this.btnCalibrateTouch.addEventListener('touchend', handleCalibStart);
    }

    // Cancel Countdown Button
    if (this.btnCancelCountdown) {
      this.btnCancelCountdown.addEventListener('click', (e) => {
        e.preventDefault();
        this.cancelCalibrationCountdown();
      });
      this.btnCancelCountdown.addEventListener('touchend', (e) => {
        e.preventDefault();
        this.cancelCalibrationCountdown();
      });
    }

    // Camera Switch / Toggle Button
    if (this.btnSwitchCamera) {
      const handleCameraSwitch = async (e) => {
        if (e) e.preventDefault();
        try {
          this.showToast('カメラを切り替え中...');
          await this.camera.cycleCamera();
          this.syncCanvasSize();
          const camLabel = this.camera.getCurrentCameraLabel();
          this.showToast(`カメラ: ${camLabel}`);
        } catch (err) {
          console.error('Camera switch error', err);
          this.showToast(`カメラ切替失敗: ${err.message || err}`);
        }
      };
      this.btnSwitchCamera.addEventListener('click', handleCameraSwitch);
      this.btnSwitchCamera.addEventListener('touchend', handleCameraSwitch);
    }

    window.addEventListener('resize', () => this.syncCanvasSize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.syncCanvasSize(), 300));
  }

  /**
   * Setup 4-Corner Draggable Quad Interaction on the Canvas
   */
  setupQuadDragging() {
    const canvas = this.canvas;
    const quad = this.analyzer.keyboardQuad;

    const getNormalizedPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;

      const cw = canvas.width || rect.width;
      const ch = canvas.height || rect.height;
      const scale = Math.min(rect.width / cw, rect.height / ch);
      const dw = cw * scale;
      const dh = ch * scale;
      const offsetX = (rect.width - dw) / 2;
      const offsetY = (rect.height - dh) / 2;

      const localX = clientX - rect.left - offsetX;
      const localY = clientY - rect.top - offsetY;

      return {
        x: Math.max(0, Math.min(1, localX / dw)),
        y: Math.max(0, Math.min(1, localY / dh))
      };
    };

    const findClosestCorner = (pos) => {
      const threshold = 0.09; // Normalized grab radius
      const corners = [
        { id: 'topLeft', p: quad.topLeft },
        { id: 'topRight', p: quad.topRight },
        { id: 'bottomRight', p: quad.bottomRight },
        { id: 'bottomLeft', p: quad.bottomLeft }
      ];

      for (const c of corners) {
        const dx = c.p.x - pos.x;
        const dy = c.p.y - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= threshold) {
          return c.id;
        }
      }
      return null;
    };

    const onStart = (e) => {
      const pos = getNormalizedPos(e);
      const cornerId = findClosestCorner(pos);
      if (cornerId) {
        this.activeDragCorner = cornerId;
        this.renderer.activeCornerDrag = cornerId;
        e.preventDefault();
      }
    };

    const onMove = (e) => {
      if (!this.activeDragCorner) return;
      e.preventDefault();
      const pos = getNormalizedPos(e);
      quad[this.activeDragCorner].x = pos.x;
      quad[this.activeDragCorner].y = pos.y;
    };

    const onEnd = () => {
      if (this.activeDragCorner) {
        this.analyzer.saveQuad();
        this.activeDragCorner = null;
        this.renderer.activeCornerDrag = null;
      }
    };

    canvas.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);

    canvas.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }

  startPipelineLoop() {
    const loop = (timestamp) => {
      if (!this.isRunning) return;
      this.processFrame(timestamp || performance.now());

      if ('requestVideoFrameCallback' in this.video) {
        this.video.requestVideoFrameCallback((now) => loop(now));
      } else {
        requestAnimationFrame(loop);
      }
    };

    if ('requestVideoFrameCallback' in this.video) {
      this.video.requestVideoFrameCallback((now) => loop(now));
    } else {
      requestAnimationFrame(loop);
    }
  }

  processFrame(timestamp) {
    if (this.isProcessingFrame) return;
    this.isProcessingFrame = true;

    // Update FPS in debug panel
    this.debugPanel.updateFPS();

    // 1. Hand Detection (Optionally with keyboard ROI crop to lower inference load)
    const roi = this.analyzer.params.useRoiCrop ? this.analyzer.getKeyboardRoi(0.12) : null;
    const rawHands = this.tracker.detectForVideo(this.video, timestamp, roi);
    this.lastRawHands = rawHands || [];

    // 2. Kinematics & Keystroke Analysis (with integrated 1€ Filter + State Machine)
    let analyzedHands = [];
    if (rawHands && rawHands.length > 0) {
      analyzedHands = this.analyzer.analyze(rawHands);
    } else {
      this.analyzer.analyze([]);
    }

    // 3. Render Canvas (Keyboard Quad, Touch Line, Hands, Fingertips)
    this.renderer.render({
      analyzedHands,
      analyzer: this.analyzer,
      isMirrored: this.camera.isMirrored
    });

    // 4. Update debug panel finger states & delegate mode
    this.debugPanel.updateFingerStates(
      this.analyzer.fingerStates,
      this.lastRawHands.length,
      this.tracker.getDelegateMode()
    );

    this.isProcessingFrame = false;
  }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
  const app = new ARPianoApp();
  app.init();
});
