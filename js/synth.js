/**
 * synth.js - Web Audio API Polyphonic Synthesizer
 * 37-key paper keyboard (22 White Keys: C3 to C6)
 */

// 22 White Keys Definition (C3 ~ C6)
export const WHITE_KEYS = [
  { index: 0,  note: 'C3', midi: 48, freq: 130.81, isC: true, isBlack: false },
  { index: 1,  note: 'D3', midi: 50, freq: 146.83, isC: false, isBlack: false },
  { index: 2,  note: 'E3', midi: 52, freq: 164.81, isC: false, isBlack: false },
  { index: 3,  note: 'F3', midi: 53, freq: 174.61, isC: false, isBlack: false },
  { index: 4,  note: 'G3', midi: 55, freq: 196.00, isC: false, isBlack: false },
  { index: 5,  note: 'A3', midi: 57, freq: 220.00, isC: false, isBlack: false },
  { index: 6,  note: 'B3', midi: 59, freq: 246.94, isC: false, isBlack: false },

  { index: 7,  note: 'C4', midi: 60, freq: 261.63, isC: true, isBlack: false }, // Middle C
  { index: 8,  note: 'D4', midi: 62, freq: 293.66, isC: false, isBlack: false },
  { index: 9,  note: 'E4', midi: 64, freq: 329.63, isC: false, isBlack: false },
  { index: 10, note: 'F4', midi: 65, freq: 349.23, isC: false, isBlack: false },
  { index: 11, note: 'G4', midi: 67, freq: 392.00, isC: false, isBlack: false },
  { index: 12, note: 'A4', midi: 69, freq: 440.00, isC: false, isBlack: false },
  { index: 13, note: 'B4', midi: 71, freq: 493.88, isC: false, isBlack: false },

  { index: 14, note: 'C5', midi: 72, freq: 523.25, isC: true, isBlack: false },
  { index: 15, note: 'D5', midi: 74, freq: 587.33, isC: false, isBlack: false },
  { index: 16, note: 'E5', midi: 76, freq: 659.25, isC: false, isBlack: false },
  { index: 17, note: 'F5', midi: 77, freq: 698.46, isC: false, isBlack: false },
  { index: 18, note: 'G5', midi: 79, freq: 783.99, isC: false, isBlack: false },
  { index: 19, note: 'A5', midi: 81, freq: 880.00, isC: false, isBlack: false },
  { index: 20, note: 'B5', midi: 83, freq: 987.77, isC: false, isBlack: false },

  { index: 21, note: 'C6', midi: 84, freq: 1046.50, isC: true, isBlack: false }
];

// 15 Black Keys Definition (C#3 ~ A#5)
export const BLACK_KEYS = [
  // Octave 3
  { index: 0,  note: 'C#3', midi: 49, freq: 138.59, afterWhiteIndex: 0, isBlack: true },
  { index: 1,  note: 'D#3', midi: 51, freq: 155.56, afterWhiteIndex: 1, isBlack: true },
  { index: 2,  note: 'F#3', midi: 54, freq: 185.00, afterWhiteIndex: 3, isBlack: true },
  { index: 3,  note: 'G#3', midi: 56, freq: 207.65, afterWhiteIndex: 4, isBlack: true },
  { index: 4,  note: 'A#3', midi: 58, freq: 233.08, afterWhiteIndex: 5, isBlack: true },

  // Octave 4
  { index: 5,  note: 'C#4', midi: 61, freq: 277.18, afterWhiteIndex: 7, isBlack: true },
  { index: 6,  note: 'D#4', midi: 63, freq: 311.13, afterWhiteIndex: 8, isBlack: true },
  { index: 7,  note: 'F#4', midi: 66, freq: 369.99, afterWhiteIndex: 10, isBlack: true },
  { index: 8,  note: 'G#4', midi: 68, freq: 415.30, afterWhiteIndex: 11, isBlack: true },
  { index: 9,  note: 'A#4', midi: 70, freq: 466.16, afterWhiteIndex: 12, isBlack: true },

  // Octave 5
  { index: 10, note: 'C#5', midi: 73, freq: 554.37, afterWhiteIndex: 14, isBlack: true },
  { index: 11, note: 'D#5', midi: 75, freq: 622.25, afterWhiteIndex: 15, isBlack: true },
  { index: 12, note: 'F#5', midi: 78, freq: 739.99, afterWhiteIndex: 17, isBlack: true },
  { index: 13, note: 'G#5', midi: 80, freq: 830.61, afterWhiteIndex: 18, isBlack: true },
  { index: 14, note: 'A#5', midi: 82, freq: 932.33, afterWhiteIndex: 19, isBlack: true }
];

export class PianoSynth {
  constructor() {
    this.ctx = null;
    this.isEnabled = true;
    this.masterGain = null;
  }

  /**
   * Unlock & Initialize AudioContext on user interaction
   */
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.4;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /**
   * Play a note by keyData object or white key index
   * @param {Object|number} keyOrIndex
   * @param {number} [velocity=0.6] Strike velocity (0.1 ~ 1.0)
   * @returns {Object|null} Triggered note info
   */
  playKey(keyOrIndex, velocity = 0.6) {
    let keyData = null;
    if (typeof keyOrIndex === 'object' && keyOrIndex !== null) {
      keyData = keyOrIndex;
    } else if (typeof keyOrIndex === 'number') {
      keyData = WHITE_KEYS[keyOrIndex];
    }
    if (!keyData || !keyData.freq) return null;
    this.playFrequency(keyData.freq, velocity, keyData.note);
    return keyData;
  }

  /**
   * Polyphonic Sound Synthesis with Triangle wave & natural decay
   * @param {number} freq Frequency in Hz
   * @param {number} velocity Strike velocity
   * @param {string} [label] Note name
   */
  playFrequency(freq, velocity = 0.6, label = '') {
    if (!this.isEnabled) return;
    this.init();

    const now = this.ctx.currentTime;
    const vol = Math.min(1.0, Math.max(0.15, velocity));

    // Acoustic Piano Timbre Simulation (Triangle Fundamental + Overtones)
    const partials = [
      { ratio: 1.0, gain: 0.85 },
      { ratio: 2.0, gain: 0.28 },
      { ratio: 3.0, gain: 0.12 },
      { ratio: 4.0, gain: 0.04 }
    ];

    const voiceGain = this.ctx.createGain();
    voiceGain.connect(this.masterGain);

    const oscNodes = [];

    partials.forEach((p) => {
      const osc = this.ctx.createOscillator();
      const pGain = this.ctx.createGain();

      osc.type = p.ratio === 1.0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq * p.ratio, now);

      pGain.gain.setValueAtTime(0.0001, now);
      // Fast percussive attack (5ms)
      pGain.gain.exponentialRampToValueAtTime(p.gain * vol * 0.5, now + 0.005);
      // Natural exponential decay (0.65s)
      pGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

      osc.connect(pGain);
      pGain.connect(voiceGain);

      osc.start(now);
      osc.stop(now + 0.7);
      oscNodes.push(osc);
    });

    // Cleanup after decay completes
    setTimeout(() => {
      voiceGain.disconnect();
    }, 800);
  }

  /**
   * Play Countdown Beep (High pitch for ticks, higher distinct tone for finish)
   * @param {boolean} [isFinal=false]
   */
  playCountdownTick(isFinal = false) {
    if (!this.isEnabled) return;
    this.init();

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = isFinal ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(isFinal ? 1318.51 : 880, now); // E6 or A5

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(isFinal ? 0.35 : 0.2, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (isFinal ? 0.4 : 0.09));

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + (isFinal ? 0.45 : 0.12));

    setTimeout(() => {
      gain.disconnect();
    }, 500);
  }

  toggleSound(enable) {
    this.isEnabled = enable !== undefined ? enable : !this.isEnabled;
    return this.isEnabled;
  }
}

