/**
 * debug-panel.js — Real-time Tuning GUI for Keystroke Detection Parameters
 * Minimalist Monochrome Edition (Black & White Clean Design)
 *
 * Provides a collapsible overlay panel with sliders for tunable parameters:
 *  - Hand Skeleton Visualizer Toggle (Show/Hide skeleton bones & joints)
 *  - 1€ Filter: minCutoff, beta
 *  - State Machine: downward velocity threshold, deceleration threshold
 *  - Kinematics: flexion threshold
 *  - Hysteresis: cooldown lift amount, margin
 *
 * Persisted to localStorage.
 */

const STORAGE_KEY = 'ar_piano_debug_params_v1';

const DEFAULT_PARAMS = {
  // Skeleton Display
  showSkeleton: false,
  // 1€ Filter
  filterMinCutoff: 1.0,
  filterBeta: 0.007,
  // State Machine
  downwardVelocityThreshold: 0.12,
  decelerationRatio: 0.5,
  // Kinematics
  flexionThreshold: 15,
  flexionEnabled: true,
  // Hysteresis
  cooldownLiftAmount: 0.03,
  hysteresisMargin: 0.025,
  cooldownTimeMs: 80,
};

const PARAM_CONFIGS = [
  {
    key: 'filterMinCutoff', label: '1€ MinCutoff (平滑化)', group: '1€ Filter',
    min: 0.1, max: 10.0, step: 0.1, unit: 'Hz'
  },
  {
    key: 'filterBeta', label: '1€ Beta (速度応答)', group: '1€ Filter',
    min: 0.0, max: 0.5, step: 0.001, unit: ''
  },
  {
    key: 'downwardVelocityThreshold', label: '下降速度閾値', group: 'ステートマシン',
    min: 0.02, max: 0.5, step: 0.01, unit: '/s'
  },
  {
    key: 'decelerationRatio', label: '減速判定比率', group: 'ステートマシン',
    min: 0.1, max: 0.95, step: 0.05, unit: ''
  },
  {
    key: 'flexionThreshold', label: '屈曲角度閾値', group: 'キネマティクス',
    min: 0, max: 60, step: 1, unit: '°'
  },
  {
    key: 'cooldownLiftAmount', label: 'CD浮上量', group: 'ヒステリシス',
    min: 0.005, max: 0.1, step: 0.005, unit: ''
  },
  {
    key: 'hysteresisMargin', label: 'ヒステリシス幅', group: 'ヒステリシス',
    min: 0.005, max: 0.08, step: 0.005, unit: ''
  },
  {
    key: 'cooldownTimeMs', label: 'クールダウン時間', group: 'ヒステリシス',
    min: 30, max: 300, step: 10, unit: 'ms'
  }
];

export class DebugPanel {
  /**
   * @param {Object} [options]
   * @param {Function} [options.onParamsChange] Callback when any parameter changes
   * @param {Function} [options.onSkeletonToggle] Callback when skeleton toggle changes
   */
  constructor(options = {}) {
    this.onParamsChange = options.onParamsChange || (() => {});
    this.onSkeletonToggle = options.onSkeletonToggle || (() => {});
    this.params = this.loadParams();
    this.isVisible = false;
    this.fingerStatesDisplay = {};
    this.fps = 0;
    this.frameCount = 0;
    this.lastFpsTime = performance.now();

    this.container = null;
    this.toggleBtn = null;
    this.fpsDisplay = null;
    this.fingerMonitor = null;
    this.sliderElements = {};

    this._createUI();
  }

  /**
   * Load params from localStorage with defaults fallback
   */
  loadParams() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...DEFAULT_PARAMS, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load debug params', e);
    }
    return { ...DEFAULT_PARAMS };
  }

  /**
   * Save current params to localStorage
   */
  saveParams() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.params));
    } catch (e) {
      console.warn('Failed to save debug params', e);
    }
  }

  /**
   * Get current parameter value
   */
  get(key) {
    return this.params[key] !== undefined ? this.params[key] : DEFAULT_PARAMS[key];
  }

  /**
   * Get all parameters
   */
  getAll() {
    return { ...this.params };
  }

  /**
   * Set parameter and notify
   */
  set(key, value) {
    this.params[key] = value;
    this.saveParams();
    if (key === 'showSkeleton') {
      this.onSkeletonToggle(value);
    }
    this.onParamsChange(key, value, this.params);
  }

  /**
   * Reset all parameters to defaults
   */
  resetToDefaults() {
    this.params = { ...DEFAULT_PARAMS };
    this.saveParams();
    // Update all sliders
    for (const cfg of PARAM_CONFIGS) {
      const el = this.sliderElements[cfg.key];
      if (el) {
        el.slider.value = this.params[cfg.key];
        el.valueLabel.textContent = this._formatValue(cfg, this.params[cfg.key]);
      }
    }
    const skelToggle = this.container.querySelector('#debug-skeleton-enabled');
    if (skelToggle) {
      skelToggle.checked = this.params.showSkeleton;
    }
    const flexToggle = this.container.querySelector('#debug-flexion-enabled');
    if (flexToggle) {
      flexToggle.checked = this.params.flexionEnabled;
    }
    this.onSkeletonToggle(this.params.showSkeleton);
    this.onParamsChange('__reset__', null, this.params);
  }

  /**
   * Create the full debug panel UI (Monochrome Clean Style)
   */
  _createUI() {
    // Toggle button
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.id = 'btn-debug-toggle';
    this.toggleBtn.className = 'btn-debug-toggle';
    this.toggleBtn.textContent = '⚙';
    this.toggleBtn.title = '設定 / デバッグパネル';
    this.toggleBtn.addEventListener('click', () => this.toggle());
    this.toggleBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      this.toggle();
    });

    // Panel container
    this.container = document.createElement('div');
    this.container.id = 'debug-panel';
    this.container.className = 'debug-panel hidden';

    // Build inner HTML
    let html = '';

    // Header
    html += `<div class="debug-panel-header">
      <span class="debug-panel-title">⚙ 設定 / パラメータ</span>
      <div class="debug-panel-header-btns">
        <button id="debug-reset-btn" class="debug-reset-btn" title="デフォルトに戻す">初期化</button>
        <button id="debug-close-btn" class="debug-close-btn" title="閉じる">✕</button>
      </div>
    </div>`;

    // FPS + Detection Monitor
    html += `<div class="debug-monitor-row">
      <span id="debug-fps" class="debug-fps">FPS: --</span>
      <span id="debug-hands" class="debug-hands">Hands: 0</span>
    </div>`;

    // Finger state monitor
    html += `<div id="debug-finger-monitor" class="debug-finger-monitor"></div>`;

    // Skeleton Overlay Toggle Group
    html += `<div class="debug-group">
      <div class="debug-group-label">表示設定</div>
      <div class="debug-toggle-row">
        <label class="debug-toggle-label">手の骨格オーバーレイ表示</label>
        <label class="debug-switch">
          <input type="checkbox" id="debug-skeleton-enabled" ${this.params.showSkeleton ? 'checked' : ''}>
          <span class="debug-switch-slider"></span>
        </label>
      </div>
    </div>`;

    // Parameter sliders grouped
    let currentGroup = '';
    for (const cfg of PARAM_CONFIGS) {
      if (cfg.group !== currentGroup) {
        if (currentGroup) html += '</div>';
        currentGroup = cfg.group;
        html += `<div class="debug-group">
          <div class="debug-group-label">${cfg.group}</div>`;
      }

      const val = this.params[cfg.key];
      html += `<div class="debug-slider-row" data-key="${cfg.key}">
        <label class="debug-slider-label">${cfg.label}</label>
        <input type="range" class="debug-slider" id="debug-slider-${cfg.key}"
               min="${cfg.min}" max="${cfg.max}" step="${cfg.step}" value="${val}">
        <span class="debug-slider-value" id="debug-value-${cfg.key}">${this._formatValue(cfg, val)}</span>
      </div>`;
    }
    if (currentGroup) html += '</div>';

    // Flexion enable toggle
    html += `<div class="debug-group">
      <div class="debug-group-label">キネマティクス</div>
      <div class="debug-toggle-row">
        <label class="debug-toggle-label">指関節屈曲判定の有効化</label>
        <label class="debug-switch">
          <input type="checkbox" id="debug-flexion-enabled" ${this.params.flexionEnabled ? 'checked' : ''}>
          <span class="debug-switch-slider"></span>
        </label>
      </div>
    </div>`;

    this.container.innerHTML = html;

    // Append to body
    const controlsBar = document.querySelector('.top-controls-bar');
    if (controlsBar) {
      controlsBar.insertBefore(this.toggleBtn, controlsBar.firstChild);
    }
    document.body.appendChild(this.container);

    // Wire up event listeners
    this._wireEvents();
  }

  _wireEvents() {
    // Close button
    const closeBtn = this.container.querySelector('#debug-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hide());
    }

    // Reset button
    const resetBtn = this.container.querySelector('#debug-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetToDefaults());
    }

    // Skeleton toggle
    const skeletonToggle = this.container.querySelector('#debug-skeleton-enabled');
    if (skeletonToggle) {
      skeletonToggle.addEventListener('change', (e) => {
        this.set('showSkeleton', e.target.checked);
      });
    }

    // Flexion toggle
    const flexionToggle = this.container.querySelector('#debug-flexion-enabled');
    if (flexionToggle) {
      flexionToggle.addEventListener('change', (e) => {
        this.set('flexionEnabled', e.target.checked);
      });
    }

    // Sliders
    for (const cfg of PARAM_CONFIGS) {
      const slider = this.container.querySelector(`#debug-slider-${cfg.key}`);
      const valueLabel = this.container.querySelector(`#debug-value-${cfg.key}`);
      if (slider && valueLabel) {
        this.sliderElements[cfg.key] = { slider, valueLabel };
        slider.addEventListener('input', (e) => {
          const numVal = parseFloat(e.target.value);
          valueLabel.textContent = this._formatValue(cfg, numVal);
          this.set(cfg.key, numVal);
        });
      }
    }

    // Cache elements
    this.fpsDisplay = this.container.querySelector('#debug-fps');
    this.handsDisplay = this.container.querySelector('#debug-hands');
    this.fingerMonitor = this.container.querySelector('#debug-finger-monitor');
  }

  _formatValue(cfg, val) {
    if (cfg.step < 0.01) return val.toFixed(3) + cfg.unit;
    if (cfg.step < 0.1) return val.toFixed(2) + cfg.unit;
    if (cfg.step < 1) return val.toFixed(1) + cfg.unit;
    return Math.round(val) + cfg.unit;
  }

  toggle() {
    this.isVisible = !this.isVisible;
    if (this.isVisible) {
      this.container.classList.remove('hidden');
      this.toggleBtn.classList.add('active');
    } else {
      this.container.classList.add('hidden');
      this.toggleBtn.classList.remove('active');
    }
  }

  show() {
    this.isVisible = true;
    this.container.classList.remove('hidden');
    this.toggleBtn.classList.add('active');
  }

  hide() {
    this.isVisible = false;
    this.container.classList.add('hidden');
    this.toggleBtn.classList.remove('active');
  }

  updateFPS() {
    this.frameCount++;
    const now = performance.now();
    const elapsed = now - this.lastFpsTime;
    if (elapsed >= 500) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed);
      this.frameCount = 0;
      this.lastFpsTime = now;
      if (this.fpsDisplay && this.isVisible) {
        this.fpsDisplay.textContent = `FPS: ${this.fps}`;
      }
    }
  }

  updateFingerStates(fingerStates, handCount = 0) {
    if (!this.isVisible) return;

    if (this.handsDisplay) {
      this.handsDisplay.textContent = `Hands: ${handCount}`;
    }

    if (!this.fingerMonitor || !fingerStates) return;

    let html = '';
    const stateColors = {
      'IDLE': '#888888',
      'DOWNWARD': '#cccccc',
      'TRIGGER': '#ffffff',
      'COOLDOWN': '#555555'
    };

    for (const [key, state] of Object.entries(fingerStates)) {
      const color = stateColors[state.state] || '#888888';
      const shortKey = key.replace('Left_', 'L:').replace('Right_', 'R:');
      const vel = (state.vy || 0).toFixed(2);
      const flex = (state.flexionAngle || 0).toFixed(0);

      html += `<div class="debug-finger-chip" style="border-color: ${color}">
        <span class="debug-finger-name">${shortKey}</span>
        <span class="debug-finger-state" style="color: ${color}">${state.state}</span>
        <span class="debug-finger-data">v:${vel} ∠${flex}°</span>
      </div>`;
    }

    this.fingerMonitor.innerHTML = html;
  }

  static injectStyles() {
    if (document.getElementById('debug-panel-styles')) return;

    const style = document.createElement('style');
    style.id = 'debug-panel-styles';
    style.textContent = `
      .btn-debug-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 38px;
        height: 38px;
        background: rgba(18, 18, 18, 0.75);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 50%;
        color: #ffffff;
        font-size: 16px;
        cursor: pointer;
        user-select: none;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
      }
      .btn-debug-toggle:hover {
        background: rgba(30, 30, 30, 0.9);
        border-color: rgba(255, 255, 255, 0.6);
        transform: translateY(-1px);
      }
      .btn-debug-toggle.active {
        background: #ffffff;
        color: #000000;
        border-color: #ffffff;
      }

      .debug-panel {
        position: fixed;
        top: max(56px, calc(env(safe-area-inset-top) + 56px));
        right: max(14px, env(safe-area-inset-right));
        width: 290px;
        max-height: calc(100vh - 80px);
        background: rgba(12, 12, 12, 0.92);
        backdrop-filter: blur(24px);
        -webkit-backdrop-filter: blur(24px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 16px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.85);
        z-index: 1000;
        overflow-y: auto;
        overflow-x: hidden;
        color: #ffffff;
        font-family: var(--font-main);
        font-size: 11px;
        touch-action: auto;
        user-select: none;
        -webkit-user-select: none;
      }

      .debug-panel::-webkit-scrollbar { width: 4px; }
      .debug-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }

      .debug-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .debug-panel-title {
        font-weight: 600;
        font-size: 12px;
        color: #ffffff;
        letter-spacing: 0.2px;
      }
      .debug-panel-header-btns { display: flex; gap: 6px; }
      .debug-reset-btn, .debug-close-btn {
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.12);
        color: rgba(255, 255, 255, 0.8);
        font-size: 10px;
        padding: 3px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s ease;
      }
      .debug-reset-btn:hover { background: rgba(255,255,255,0.2); color: #ffffff; }
      .debug-close-btn:hover { background: rgba(255,255,255,0.2); color: #ffffff; }

      .debug-monitor-row {
        display: flex;
        justify-content: space-between;
        padding: 7px 14px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        font-size: 11px;
        font-weight: 600;
      }
      .debug-fps { color: #ffffff; }
      .debug-hands { color: rgba(255, 255, 255, 0.7); }

      .debug-finger-monitor {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 7px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        min-height: 28px;
      }
      .debug-finger-chip {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 2px 6px;
        border: 1px solid rgba(255,255,255,0.2);
        border-radius: 6px;
        background: rgba(255,255,255,0.04);
        min-width: 46px;
      }
      .debug-finger-name { font-size: 8px; color: rgba(255,255,255,0.6); font-weight: 600; }
      .debug-finger-state { font-size: 9px; font-weight: 700; }
      .debug-finger-data { font-size: 7px; color: rgba(255,255,255,0.4); font-family: monospace; }

      .debug-group {
        padding: 7px 14px 9px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .debug-group-label {
        font-size: 9px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.5);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 5px;
      }

      .debug-slider-row {
        display: grid;
        grid-template-columns: 1fr 90px 38px;
        align-items: center;
        gap: 6px;
        margin: 3px 0;
      }
      .debug-slider-label {
        font-size: 10px;
        color: rgba(255,255,255,0.75);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .debug-slider {
        width: 100%;
        height: 4px;
        -webkit-appearance: none;
        appearance: none;
        background: rgba(255,255,255,0.15);
        border-radius: 2px;
        outline: none;
      }
      .debug-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #ffffff;
        cursor: pointer;
        border: none;
        box-shadow: 0 0 6px rgba(255,255,255,0.4);
      }
      .debug-slider::-moz-range-thumb {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #ffffff;
        cursor: pointer;
        border: none;
      }
      .debug-slider-value {
        font-size: 10px;
        color: #ffffff;
        font-family: monospace;
        text-align: right;
        font-weight: 600;
      }

      .debug-toggle-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 3px 0;
      }
      .debug-toggle-label {
        font-size: 10px;
        color: rgba(255,255,255,0.75);
      }
      .debug-switch {
        position: relative;
        display: inline-block;
        width: 32px;
        height: 18px;
      }
      .debug-switch input { opacity: 0; width: 0; height: 0; }
      .debug-switch-slider {
        position: absolute;
        cursor: pointer;
        inset: 0;
        background: rgba(255,255,255,0.15);
        border-radius: 9px;
        transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .debug-switch-slider::before {
        content: '';
        position: absolute;
        height: 14px;
        width: 14px;
        left: 2px;
        bottom: 2px;
        background: rgba(255,255,255,0.6);
        border-radius: 50%;
        transition: 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .debug-switch input:checked + .debug-switch-slider {
        background: #ffffff;
      }
      .debug-switch input:checked + .debug-switch-slider::before {
        transform: translateX(14px);
        background: #000000;
      }
    `;
    document.head.appendChild(style);
  }
}
