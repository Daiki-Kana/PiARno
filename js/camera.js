/**
 * camera.js - Ultra-Wide Angle & Mobile Optimized WebRTC Camera Manager
 * Maximizes Field-of-View (FOV) with 0.5x Ultra-Wide auto-detection & 4:3 sensor full coverage
 */

export class CameraManager {
  /**
   * @param {HTMLVideoElement} videoElement
   * @param {Object} options
   * @param {number} [options.width=1920]
   * @param {number} [options.height=1440]
   * @param {'environment'|'user'} [options.defaultFacingMode='environment']
   * @param {boolean} [options.mirrored=false]
   */
  constructor(videoElement, options = {}) {
    this.video = videoElement;
    // 4:3 full-sensor ratio yields the widest unobstructed field-of-view on mobile sensors (prevents 16:9 crop)
    this.targetWidth = options.width || 1920;
    this.targetHeight = options.height || 1440;
    this.facingMode = options.defaultFacingMode || 'environment';
    this.isMirrored = options.mirrored !== undefined ? options.mirrored : false;
    this.stream = null;
    this.availableDevices = [];
    this.currentDeviceId = null;
    this.hasAutoSwitchedUltraWide = false;
    this.currentZoom = 1;

    // Strict iOS Safari video element requirements
    this.video.setAttribute('playsinline', 'true');
    this.video.setAttribute('webkit-playsinline', 'true');
    this.video.setAttribute('muted', 'true');
    this.video.setAttribute('autoplay', 'true');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.controls = false;
  }

  /**
   * Start camera with ultra-wide angle prioritization & robust iOS Safari compatibility
   */
  async start() {
    this.stop();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (!window.isSecureContext) {
        throw new Error('カメラの利用には HTTPS 接続が必要です。https:// でアクセスしてください。');
      }
      throw new Error('お使いのブラウザはカメラAPI (MediaDevices) に対応していません。Safari または Chrome をご利用ください。');
    }

    // Attempt to discover available devices if permissions were already granted
    let ultraWideDeviceId = null;
    try {
      await this.updateAvailableDevices();
      ultraWideDeviceId = this.findUltraWideDeviceId();
    } catch (e) {
      // Ignore initial enumeration error prior to permission grant
    }

    // Constraints priority list for maximum FOV (Full-Sensor 4:3 & Ultra-Wide)
    const constraintsList = [];

    // 1. Explicit ultra-wide device if found
    if (ultraWideDeviceId && this.facingMode === 'environment') {
      constraintsList.push({
        audio: false,
        video: {
          deviceId: { exact: ultraWideDeviceId },
          width: { ideal: this.targetWidth, min: 1280 },
          height: { ideal: this.targetHeight, min: 960 },
          aspectRatio: { ideal: 4 / 3 }
        }
      });
    }

    // 2. High-res 4:3 full-sensor environment camera
    constraintsList.push(
      {
        audio: false,
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: this.targetWidth, min: 1280 },
          height: { ideal: this.targetHeight, min: 960 },
          aspectRatio: { ideal: 4 / 3 }
        }
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      },
      {
        audio: false,
        video: {
          facingMode: this.facingMode
        }
      },
      {
        audio: false,
        video: true
      }
    );

    let lastError = null;
    for (const constraints of constraintsList) {
      try {
        console.log('Requesting camera stream with constraints:', constraints);
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (this.stream) break;
      } catch (err) {
        lastError = err;
        console.warn('Camera constraint attempt failed, trying fallback...', constraints, err);
      }
    }

    if (!this.stream) {
      if (lastError && (lastError.name === 'NotAllowedError' || lastError.name === 'PermissionDeniedError')) {
        throw new Error('カメラへのアクセスが拒否されました。ブラウザの設定でカメラ許可を有効にしてください。');
      }
      throw lastError || new Error('カメラデバイスへの接続に失敗しました。');
    }

    this.video.srcObject = this.stream;

    // Apply hardware minimum zoom (0.5x / widest possible field of view)
    await this.applyMaxWideZoom();

    // Explicit play with user interaction support for iOS Safari
    await new Promise((resolve) => {
      const onReady = () => {
        this.video.play()
          .then(() => resolve(this.stream))
          .catch((e) => {
            console.warn('video.play() was rejected, retrying on user interaction:', e);
            resolve(this.stream);
          });
      };

      if (this.video.readyState >= 2) {
        onReady();
      } else {
        this.video.onloadedmetadata = onReady;
        setTimeout(onReady, 800);
      }
    });

    await this.updateAvailableDevices();

    // If we started with default camera but have an ultra-wide camera available, auto-switch to it once
    if (!this.hasAutoSwitchedUltraWide && this.facingMode === 'environment') {
      const bestWideId = this.findUltraWideDeviceId();
      const currentTrack = this.stream?.getVideoTracks()[0];
      const currentSettings = currentTrack?.getSettings ? currentTrack.getSettings() : null;
      if (bestWideId && currentSettings && currentSettings.deviceId !== bestWideId) {
        console.log(`Auto-switching to detected Ultra-Wide camera: ${bestWideId}`);
        this.hasAutoSwitchedUltraWide = true;
        try {
          await this.selectDevice(bestWideId);
          await this.applyMaxWideZoom();
        } catch (switchErr) {
          console.warn('Auto-switch to ultra-wide camera failed, keeping current stream', switchErr);
        }
      }
    }

    return this.stream;
  }

  /**
   * Apply hardware minimum zoom (0.5x / widest possible field of view)
   */
  async applyMaxWideZoom() {
    try {
      const track = this.stream?.getVideoTracks()[0];
      if (track && track.getCapabilities && track.applyConstraints) {
        const capabilities = track.getCapabilities();
        if (capabilities.zoom) {
          const minZoom = capabilities.zoom.min !== undefined ? capabilities.zoom.min : 1;
          this.currentZoom = minZoom;
          await track.applyConstraints({
            advanced: [{ zoom: minZoom }]
          }).catch(() => {});
          console.log(`Applied hardware minimum camera zoom: ${minZoom}x`);
        }
      }
    } catch (zoomErr) {
      console.log('Camera zoom adjustment not supported or skipped:', zoomErr);
    }
  }

  /**
   * Find ultra-wide camera device ID from enumerated device labels
   */
  findUltraWideDeviceId() {
    if (!this.availableDevices || this.availableDevices.length === 0) return null;

    const backDevices = this.availableDevices.filter((d) => {
      const label = (d.label || '').toLowerCase();
      return !label.includes('front') && !label.includes('facetime') && !label.includes('selfie') && !label.includes('前面') && !label.includes('内側');
    });

    if (backDevices.length === 0) return null;

    // 1. Look for explicit ultra-wide keywords in label
    const ultraWideKeywords = [
      'ultra', '0.5', '超広角', '0.6', 'super wide', 'ultrawide', 'wide-angle', 'back 0', 'camera 0'
    ];
    for (const kw of ultraWideKeywords) {
      const match = backDevices.find((d) => (d.label || '').toLowerCase().includes(kw));
      if (match) return match.deviceId;
    }

    // 2. If multiple back devices exist and no explicit keyword, often index 0 or index 1 is ultra-wide
    // On iPhone Triple camera, index 0 is typically Ultra-Wide (0.5x)
    if (backDevices.length > 1) {
      return backDevices[0].deviceId;
    }

    return null;
  }

  /**
   * Stop camera stream
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  /**
   * Switch between front and environment cameras
   */
  async toggleFacingMode() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    this.isMirrored = (this.facingMode === 'user');
    return this.start();
  }

  /**
   * Cycle to next available camera device (Ultra Wide -> Standard Back -> Front)
   */
  async cycleCamera() {
    await this.updateAvailableDevices();
    if (this.availableDevices.length <= 1) {
      return this.toggleFacingMode();
    }

    const currentTrack = this.stream?.getVideoTracks()[0];
    const currentSettings = currentTrack?.getSettings ? currentTrack.getSettings() : null;
    const currentId = currentSettings?.deviceId;

    let currentIdx = this.availableDevices.findIndex((d) => d.deviceId === currentId);
    if (currentIdx === -1) currentIdx = 0;

    const nextIdx = (currentIdx + 1) % this.availableDevices.length;
    const nextDevice = this.availableDevices[nextIdx];

    console.log(`Cycling camera: switching from ${currentIdx} to ${nextIdx} (${nextDevice.label || nextDevice.deviceId})`);
    const nextLabel = (nextDevice.label || '').toLowerCase();
    const isFront = nextLabel.includes('front') || nextLabel.includes('facetime') || nextLabel.includes('selfie') || nextLabel.includes('前面') || nextLabel.includes('内側');
    this.isMirrored = isFront;
    this.facingMode = isFront ? 'user' : 'environment';

    await this.selectDevice(nextDevice.deviceId);
    await this.applyMaxWideZoom();
    return nextDevice;
  }

  /**
   * Get description of active camera (e.g. '背面超広角 (0.5x)', '背面広角 (1x)', 'インカメラ')
   */
  getCurrentCameraLabel() {
    if (this.isMirrored || this.facingMode === 'user') {
      return 'インカメラ (前面)';
    }
    const currentTrack = this.stream?.getVideoTracks()[0];
    const label = (currentTrack?.label || '').toLowerCase();
    if (label.includes('ultra') || label.includes('0.5') || label.includes('超広角') || this.currentZoom < 1) {
      return '背面 超広角 (0.5x)';
    }
    return '背面 広角 (1x)';
  }

  /**
   * Toggle mirror mode
   */
  setMirror(value) {
    this.isMirrored = value !== undefined ? value : !this.isMirrored;
    return this.isMirrored;
  }

  /**
   * Enumerate devices safely
   */
  async updateAvailableDevices() {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        this.availableDevices = devices.filter((d) => d.kind === 'videoinput');
        const currentTrack = this.stream?.getVideoTracks()[0];
        const currentSettings = currentTrack?.getSettings ? currentTrack.getSettings() : null;
        this.currentDeviceId = currentSettings?.deviceId || null;
      }
    } catch (err) {
      console.warn('Could not enumerate devices', err);
    }
    return this.availableDevices;
  }

  /**
   * Select specific device
   */
  async selectDevice(deviceId) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: this.targetWidth },
        height: { ideal: this.targetHeight },
        aspectRatio: { ideal: 4 / 3 }
      }
    });
    this.video.srcObject = this.stream;
    await new Promise((resolve) => {
      this.video.onloadedmetadata = () => {
        this.video.play().catch(() => {});
        resolve(this.stream);
      };
    });
    this.currentDeviceId = deviceId;
    await this.applyMaxWideZoom();
    return this.stream;
  }

  /**
   * Get actual video dimensions
   */
  getVideoSize() {
    return {
      width: this.video.videoWidth || this.targetWidth,
      height: this.video.videoHeight || this.targetHeight
    };
  }
}

