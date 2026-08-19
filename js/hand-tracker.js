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
  }

  /**
   * Initialize MediaPipe Wasm & HandLandmarker with GPU->CPU fallback
   * @param {Function} [onProgress] Callback for progress updates
   */
  async initialize(onProgress = () => {}) {
    onProgress('Loading Wasm fileset...');
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    const modelAssetPath = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

    // 1. Try GPU Delegate (Fastest)
    try {
      onProgress('Initializing GPU HandLandmarker...');
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
    } catch (gpuError) {
      console.warn('GPU Delegate failed on this browser, falling back to CPU Wasm...', gpuError);
      onProgress('Falling back to CPU Wasm...');
      // 2. Fallback to CPU Delegate (Reliable on all iOS/WebKit versions)
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
    }

    this.isReady = true;
    onProgress('HandLandmarker Ready');
  }

  /**
   * Detect hands for current video frame
   * @param {HTMLVideoElement} video
   * @param {number} timestamp Timestamp in milliseconds
   * @returns {Array<HandData>|null}
   */
  detectForVideo(video, timestamp) {
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
      const result = this.landmarker.detectForVideo(video, ts);
      return this.processResults(result, ts);
    } catch (err) {
      // In case of frame timing conflict, gracefully skip
      return null;
    }
  }

  /**
   * Process raw MediaPipe output into structured HandData array
   * @param {Object} result
   * @param {number} timestamp
   * @returns {Array<HandData>}
   */
  processResults(result, timestamp) {
    if (!result || !result.landmarks || result.landmarks.length === 0) {
      return [];
    }

    const hands = [];

    for (let i = 0; i < result.landmarks.length; i++) {
      const landmarks = result.landmarks[i];
      const worldLandmarks = result.worldLandmarks ? result.worldLandmarks[i] : null;
      const handednessInfo = result.handednesses && result.handednesses[i] ? result.handednesses[i][0] : null;

      const rawHandedness = handednessInfo ? handednessInfo.categoryName : 'Unknown';
      const score = handednessInfo ? handednessInfo.score : 1.0;

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
