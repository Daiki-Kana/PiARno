/**
 * hand-tracker.js - MediaPipe Tasks Vision HandLandmarker Wrapper
 * iOS Safari & Mobile Compatible with GPU -> CPU Fallback
 */

import { FilesetResolver, HandLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17]
];

export const FINGER_TIPS = {
  THUMB: 4,
  INDEX: 8,
  MIDDLE: 12,
  RING: 16,
  PINKY: 20
};

export const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
export const FINGER_INDICES = [4, 8, 12, 16, 20];

export class HandTracker {
  /**
   * @param {Object} [options]
   * @param {number} [options.numHands=2]
   * @param {number} [options.minDetectionConfidence=0.6]
   * @param {number} [options.minPresenceConfidence=0.6]
   * @param {number} [options.minTrackingConfidence=0.6]
   */
  constructor(options = {}) {
    this.numHands = options.numHands || 2;
    this.minDetectionConfidence = options.minDetectionConfidence || 0.6;
    this.minPresenceConfidence = options.minPresenceConfidence || 0.6;
    this.minTrackingConfidence = options.minTrackingConfidence || 0.6;

    this.landmarker = null;
    this.isReady = false;
    this.lastProcessedTimestamp = 0;
    this.delegateMode = 'UNKNOWN'; // 'GPU' | 'CPU' | 'UNKNOWN'

    // Offscreen / Scratch Canvas for ROI Crop Inference
    this._roiCanvas = null;
    this._roiCtx = null;
  }

  /**
   * Get active delegate mode ('GPU' | 'CPU' | 'UNKNOWN')
   * @returns {string}
   */
  getDelegateMode() {
    return this.delegateMode;
  }

  /**
   * Initialize MediaPipe Wasm & HandLandmarker with GPU->CPU fallback
   * @param {Function} [onProgress] Callback for progress updates
   */
  async initialize(onProgress = () => {}) {
    onProgress('Wasmファイルを読み込み中...');
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    const modelAssetPath = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

    // 1. Try GPU Delegate (Fastest)
    try {
      console.log('[HandTracker] GPU Delegate で HandLandmarker を初期化しています...');
      onProgress('GPU Delegate で初期化中...');
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath,
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: this.numHands,
        minHandDetectionConfidence: this.minDetectionConfidence,
        minHandPresenceConfidence: this.minPresenceConfidence,
        minTrackingConfidence: this.minTrackingConfidence
      });
      this.delegateMode = 'GPU';
      console.info('[HandTracker] ✅ GPU Delegate (WebGL) が有効になりました。');
    } catch (gpuError) {
      console.warn('[HandTracker] ⚠️ GPU Delegate の初期化に失敗しました。CPU Wasm Delegate に自動フォールバックします:', gpuError);
      onProgress('CPU Wasm Delegate にフォールバック中...');

      // 2. Fallback to CPU Delegate (Reliable on all iOS/WebKit versions)
      try {
        this.landmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath,
            delegate: 'CPU'
          },
          runningMode: 'VIDEO',
          numHands: this.numHands,
          minHandDetectionConfidence: this.minDetectionConfidence,
          minHandPresenceConfidence: this.minPresenceConfidence,
          minTrackingConfidence: this.minTrackingConfidence
        });
        this.delegateMode = 'CPU';
        console.info('[HandTracker] ✅ CPU Delegate (Wasm) フォールバックで正常に起動しました。');
      } catch (cpuError) {
        this.delegateMode = 'UNKNOWN';
        console.error('[HandTracker] ❌ CPU Delegate 初期化も失敗しました:', cpuError);
        throw cpuError;
      }
    }

    this.isReady = true;
    onProgress(`HandLandmarker (${this.delegateMode}) 準備完了`);
  }

  /**
   * Detect hands for current video frame with optional keyboard ROI cropping
   * @param {HTMLVideoElement} video
   * @param {number} timestamp Timestamp in milliseconds
   * @param {Object} [roi=null] Optional bounding box { minX, minY, maxX, maxY } in [0..1]
   * @returns {Array<HandData>|null}
   */
  detectForVideo(video, timestamp, roi = null) {
    if (!this.isReady || !this.landmarker || video.readyState < 2) {
      return null;
    }

    // Ensure timestamp increases monotonically (required by MediaPipe VIDEO mode)
    let ts = timestamp;
    if (ts <= this.lastProcessedTimestamp) {
      ts = this.lastProcessedTimestamp + 1;
    }
    this.lastProcessedTimestamp = ts;

    try {
      // If valid ROI is provided, crop the input video to reduce inference load
      if (roi && roi.width > 0.05 && roi.height > 0.05) {
        const inputSource = this._prepareRoiCrop(video, roi);
        const result = this.landmarker.detectForVideo(inputSource, ts);
        return this.processResults(result, ts, roi);
      } else {
        const result = this.landmarker.detectForVideo(video, ts);
        return this.processResults(result, ts, null);
      }
    } catch (err) {
      // In case of frame timing conflict, gracefully skip
      return null;
    }
  }

  /**
   * Draw cropped ROI region from video to internal scratch canvas
   */
  _prepareRoiCrop(video, roi) {
    const vw = video.videoWidth || 1920;
    const vh = video.videoHeight || 1440;

    const sx = Math.floor(roi.minX * vw);
    const sy = Math.floor(roi.minY * vh);
    const sw = Math.max(32, Math.floor(roi.width * vw));
    const sh = Math.max(32, Math.floor(roi.height * vh));

    if (!this._roiCanvas) {
      this._roiCanvas = document.createElement('canvas');
      this._roiCtx = this._roiCanvas.getContext('2d', { willReadFrequently: false });
    }

    if (this._roiCanvas.width !== sw || this._roiCanvas.height !== sh) {
      this._roiCanvas.width = sw;
      this._roiCanvas.height = sh;
    }

    this._roiCtx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    return this._roiCanvas;
  }

  /**
   * Process raw MediaPipe output into structured HandData array
   * Inverse transforms ROI local coordinates back to original full video [0..1] space
   * @param {Object} result
   * @param {number} timestamp
   * @param {Object|null} roi
   * @returns {Array<HandData>}
   */
  processResults(result, timestamp, roi = null) {
    if (!result || !result.landmarks || result.landmarks.length === 0) {
      return [];
    }

    const hands = [];

    for (let i = 0; i < result.landmarks.length; i++) {
      let landmarks = result.landmarks[i];
      const worldLandmarks = result.worldLandmarks ? result.worldLandmarks[i] : null;
      const handednessInfo = result.handednesses && result.handednesses[i] ? result.handednesses[i][0] : null;

      const rawHandedness = handednessInfo ? handednessInfo.categoryName : 'Unknown';
      const score = handednessInfo ? handednessInfo.score : 1.0;

      // If ROI crop was used, project landmarks back to original full-screen [0..1] coordinates
      if (roi) {
        const roiW = roi.maxX - roi.minX;
        const roiH = roi.maxY - roi.minY;
        landmarks = landmarks.map((pt) => ({
          x: roi.minX + pt.x * roiW,
          y: roi.minY + pt.y * roiH,
          z: (pt.z || 0) * roiW
        }));
      }

      hands.push({
        handIndex: i,
        handedness: rawHandedness,
        score,
        timestamp,
        landmarks,
        worldLandmarks,
        tips: {
          thumb: landmarks[4],
          index: landmarks[8],
          middle: landmarks[12],
          ring: landmarks[16],
          pinky: landmarks[20]
        },
        worldTips: worldLandmarks ? {
          thumb: worldLandmarks[4],
          index: worldLandmarks[8],
          middle: worldLandmarks[12],
          ring: worldLandmarks[16],
          pinky: worldLandmarks[20]
        } : null
      });
    }

    return hands;
  }
}
