/**
 * StatusFooter - Persistent terminal status bar for live agent monitoring
 *
 * Displays:
 * - Agent status icons (🟢 running, ⏳ waiting, 🔄 processing, etc.)
 * - Real-time CPU, memory, network metrics per agent
 * - Cluster summary stats
 *
 * Uses ANSI escape sequences to maintain a fixed footer while
 * allowing normal terminal output to scroll above it.
 *
 * ROBUST RESIZE HANDLING:
 * - Debounced resize events (100ms) prevent rapid-fire redraws
 * - Render lock prevents concurrent renders from corrupting state
 * - Full footer clear before scroll region reset prevents artifacts
 * - Dimension checkpointing skips unnecessary redraws
 * - Graceful degradation for terminals < 8 rows
 */

const { getProcessMetrics } = require('./process-metrics');

// ANSI escape codes
const ESC = '\x1b';
const CSI = `${ESC}[`;

// Terminal manipulation
const SAVE_CURSOR = `${CSI}s`;
const RESTORE_CURSOR = `${CSI}u`;
const CLEAR_LINE = `${CSI}2K`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

// Colors
const COLORS = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  cyan: `${CSI}36m`,
  green: `${CSI}32m`,
  yellow: `${CSI}33m`,
  red: `${CSI}31m`,
  gray: `${CSI}90m`,
  white: `${CSI}37m`,
  bgBlack: `${CSI}40m`,
};

/**
 * Canonical agent state constants - SINGLE SOURCE OF TRUTH
 * Use these instead of magic strings throughout the codebase
 */
const AGENT_STATE = Object.freeze({
  IDLE: 'idle',
  EXECUTING_TASK: 'executing_task',
  EVALUATING_LOGIC: 'evaluating_logic',
  BUILDING_CONTEXT: 'building_context',
});

// Agent states that indicate "active" work (from agent-lifecycle.js)
// These should show in the footer with metrics
const ACTIVE_STATES = new Set([
  AGENT_STATE.EXECUTING_TASK, // Actually running claude CLI
  AGENT_STATE.EVALUATING_LOGIC, // Evaluating trigger conditions
  AGENT_STATE.BUILDING_CONTEXT, // Building context for task
]);

/**
 * Debounce function - prevents rapid-fire calls during resize
 * @param {Function} fn - Function to debounce
 * @param {number} ms - Debounce delay in milliseconds
 * @returns {Function} Debounced function
 */
function debounce(fn, ms) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}

/**
 * @typedef {Object} AgentState
 * @property {string} id - Agent ID
 * @property {string} state - Agent state (idle, executing, etc.)
 * @property {number|null} processPid - Process ID if running (preferred)
 * @property {number|null} pid - Legacy alias for processPid
 * @property {number} iteration - Current iteration
 */

class StatusFooter {
  /**
   * @param {Object} options
   * @param {number} [options.samplingInterval=500] - Background metrics sampling interval in ms
   * @param {number} [options.refreshInterval=100] - Display refresh interval in ms (10 fps)
   * @param {number} [options.interpolationSpeed=0.15] - Lerp factor (0-1) per refresh tick
   * @param {boolean} [options.enabled=true] - Whether footer is enabled
   * @param {number} [options.maxAgentRows=5] - Max agent rows to display
   */
  constructor(options = {}) {
    // INTERPOLATION ARCHITECTURE:
    // - Sample actual metrics every 500ms (background, non-blocking)
    // - Display updates every 100ms (10 fps - appears continuous)
    // - Values smoothly drift toward actual measurements via lerp
    // - Result: Real-time seeming monitoring even with less frequent polling
    this.samplingInterval = options.samplingInterval || 500; // Actual metrics poll (ms)
    this.refreshInterval = options.refreshInterval || 100; // Display update rate (ms) - was 1000
    this.interpolationSpeed = options.interpolationSpeed || 0.15; // Lerp factor per tick
    this.enabled = options.enabled !== false;
    this.maxAgentRows = options.maxAgentRows || 5;
    this.intervalId = null;
    this.samplingIntervalId = null; // Background metrics sampler
    this.agents = new Map(); // agentId -> AgentState
    // Interpolated metrics: { current: {...}, target: {...}, lastSampleTime, exists }
    // - current: Displayed value (interpolated toward target)
    // - target: Actual measured value from last sample
    this.interpolatedMetrics = new Map(); // agentId -> InterpolatedMetrics
    this.footerHeight = 3; // Minimum: header + 1 agent row + summary
    this.lastFooterHeight = 3;
    this.scrollRegionSet = false;
    this.clusterId = null;
    this.clusterState = 'initializing';
    this.runMode = null;
    this.startTime = Date.now();
    this.messageBus = null; // MessageBus for token usage tracking

    // Robust resize handling state
    this.isRendering = false; // Render lock - prevents concurrent renders
    this.pendingResize = false; // Queue resize if render in progress
    this.lastKnownRows = 0; // Track terminal dimensions for change detection
    this.lastKnownCols = 0;
    this.minRows = 8; // Minimum rows for footer display (graceful degradation)
    this.hidden = false; // True when terminal too small for footer

    // Output queue - serializes all stdout to prevent cursor corruption
    // When scroll region is active, console.log() can corrupt cursor position
    // All output must go through print() to coordinate with render cycles
    this.printQueue = [];

    // Blink state for executing agents - toggles on each render for visual pulse
    this.blinkState = false;

    // Debounced resize handler (100ms) - prevents rapid-fire redraws
    this._debouncedResize = debounce(() => this._handleResize(), 100);
  }

  /**
   * Check if we're in a TTY that supports the footer
   * @returns {boolean}
   */
  isTTY() {
    return process.stdout.isTTY === true;
  }

  /**
   * Print one logical line while coordinating with footer rendering.
   * The caller owns line normalization; this method appends one newline.
   * @param {string} text
   */
  print(text) {
    this._queueOrWrite(`${text}\n`);
  }

  /**
   * Write an exact streaming chunk while coordinating with footer rendering.
   * @param {string} text
   */
  write(text) {
    this._queueOrWrite(String(text));
  }

  /** @private */
  _queueOrWrite(text) {
    if (this.isRendering) {
      this.printQueue.push(text);
      return;
    }
    process.stdout.write(text);
  }

  /**
   * Flush queued output to stdout.
   * Called after render() restores cursor to ensure proper positioning.
   * @private
   */
  _flushPrintQueue() {
    if (this.printQueue.length === 0) return;

    const output = this.printQueue.join('');
    this.printQueue = [];
    process.stdout.write(output);
  }

  /**
   * Get terminal dimensions
   * @returns {{ rows: number, cols: number }}
   */
  getTerminalSize() {
    return {
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    };
  }

  /**
   * Move cursor to specific position
   * @param {number} row - 1-based row
   * @param {number} col - 1-based column
   */
  moveTo(row, col) {
    process.stdout.write(`${CSI}${row};${col}H`);
  }

  /**
   * Clear a specific line completely
   * @param {number} row - 1-based row number
   * @private
   */
  _clearLine(row) {
    process.stdout.write(`${CSI}${row};1H${CLEAR_LINE}`);
  }

  /**
   * Generate move cursor ANSI sequence (returns string, doesn't write)
   * Used for atomic buffered writes to prevent interleaving
   * @param {number} row - 1-based row
   * @param {number} col - 1-based column
   * @returns {string} ANSI escape sequence
   * @private
   */
  _moveToStr(row, col) {
    return `${CSI}${row};${col}H`;
  }

  /**
   * Generate clear line ANSI sequence (returns string, doesn't write)
   * Used for atomic buffered writes to prevent interleaving
   * @param {number} row - 1-based row number
   * @returns {string} ANSI escape sequence
   * @private
   */
  _clearLineStr(row) {
    return `${CSI}${row};1H${CLEAR_LINE}`;
  }

  /**
   * Generate ANSI sequences to clear all footer lines (returns string)
   * Used for atomic buffered writes to prevent interleaving
   * @returns {string} ANSI escape sequences
   * @private
   */
  _clearFooterAreaStr() {
    const { rows } = this.getTerminalSize();
    // Use max of current and last footer height to ensure full cleanup
    const heightToClear = Math.max(this.footerHeight, this.lastFooterHeight, 3);
    const startRow = Math.max(1, rows - heightToClear + 1);

    let buffer = '';
    for (let row = startRow; row <= rows; row++) {
      buffer += this._clearLineStr(row);
    }
    return buffer;
  }

  /**
   * Clear all footer lines (uses last known height for safety)
   * Uses single atomic write to prevent interleaving with other processes
   * @private
   */
  _clearFooterArea() {
    process.stdout.write(this._clearFooterAreaStr());
  }

  /**
   * Set up scroll region to reserve space for footer
   * ROBUST: Clears footer area first, resets to full screen, then sets new region
   * Uses single atomic write to prevent interleaving with other processes
   */
  setupScrollRegion() {
    if (!this.isTTY()) return;

    const { rows, cols } = this.getTerminalSize();

    // Graceful degradation: hide footer if terminal too small
    if (rows < this.minRows) {
      if (!this.hidden) {
        this.hidden = true;
        // Reset to full screen scroll
        process.stdout.write(`${CSI}1;${rows}r`);
        this.scrollRegionSet = false;
      }
      return;
    }

    // Restore footer if terminal grew large enough
    if (this.hidden) {
      this.hidden = false;
    }

    const scrollEnd = rows - this.footerHeight;

    // BUILD ENTIRE OUTPUT INTO SINGLE BUFFER for atomic write
    let buffer = '';

    // Step 1: Save cursor before any manipulation
    buffer += SAVE_CURSOR;
    buffer += HIDE_CURSOR;

    // Step 2: Reset scroll region to full screen first (prevents artifacts)
    buffer += `${CSI}1;${rows}r`;

    // Step 3: Clear footer area completely (prevents ghosting)
    buffer += this._clearFooterAreaStr();

    // Step 4: Set new scroll region (lines 1 to scrollEnd)
    buffer += `${CSI}1;${scrollEnd}r`;

    // Step 5: Move cursor to bottom of scroll region (safe position)
    buffer += this._moveToStr(scrollEnd, 1);

    // Step 6: Restore cursor and show it
    buffer += RESTORE_CURSOR;
    buffer += SHOW_CURSOR;

    // SINGLE ATOMIC WRITE - prevents interleaving
    process.stdout.write(buffer);

    this.scrollRegionSet = true;
    this.lastKnownRows = rows;
    this.lastKnownCols = cols;
  }

  /**
   * Generate reset scroll region string (returns string, doesn't write)
   * @private
   */
  _resetScrollRegionStr() {
    const { rows } = this.getTerminalSize();
    return `${CSI}1;${rows}r`;
  }

  /**
   * Reset scroll region to full terminal
   */
  resetScrollRegion() {
    if (!this.isTTY()) return;

    process.stdout.write(this._resetScrollRegionStr());
    this.scrollRegionSet = false;
  }

  /**
   * Handle terminal resize event
   * Called via debounced wrapper to prevent rapid-fire redraws
   * @private
   */
  _handleResize() {
    if (!this.isTTY()) return;

    const { rows, cols } = this.getTerminalSize();

    // Skip if dimensions haven't actually changed (debounce may still fire)
    if (rows === this.lastKnownRows && cols === this.lastKnownCols) {
      return;
    }

    // If render in progress, queue resize for after
    if (this.isRendering) {
      this.pendingResize = true;
      return;
    }

    // Update dimensions and reconfigure
    this.lastKnownRows = rows;
    this.lastKnownCols = cols;

    this.setupScrollRegion();
    this.render();
  }

  /**
   * Register cluster for monitoring
   * @param {string} clusterId
   */
  setCluster(clusterId) {
    this.clusterId = clusterId;
  }

  /**
   * Set message bus for token usage tracking
   * @param {object} messageBus - MessageBus instance with getTokensByRole()
   */
  setMessageBus(messageBus) {
    this.messageBus = messageBus;
  }

  /**
   * Update cluster state
   * @param {string} state
   */
  setClusterState(state) {
    this.clusterState = state;
  }

  /**
   * Set the armed run mode (e.g. 'ship', 'pr', 'worktree', 'docker')
   * @param {string|null} mode
   */
  setRunMode(mode) {
    this.runMode = mode;
  }

  /**
   * Register an agent for monitoring
   * @param {AgentState} agentState
   */
  updateAgent(agentState) {
    const processPid = agentState.processPid ?? agentState.pid ?? null;
    this.agents.set(agentState.id, {
      ...agentState,
      processPid,
      pid: processPid,
      lastUpdate: Date.now(),
    });
  }

  /**
   * Remove an agent from monitoring
   * @param {string} agentId
   */
  removeAgent(agentId) {
    this.agents.delete(agentId);
    this.interpolatedMetrics.delete(agentId);
  }

  /**
   * Background metrics sampling - polls actual CPU/RAM every samplingInterval ms
   * Updates target values that display will interpolate toward
   * @private
   */
  async _sampleMetrics() {
    for (const [agentId, agent] of this.agents) {
      const processPid = agent.processPid ?? agent.pid;
      if (!processPid) continue;

      try {
        // Get actual metrics with 200ms sample window (for CPU calculation)
        const raw = await getProcessMetrics(processPid, { samplePeriodMs: 200 });
        const existing = this.interpolatedMetrics.get(agentId);

        this.interpolatedMetrics.set(agentId, {
          // Keep interpolating from current position (smooth transition)
          current: existing?.current || {
            cpuPercent: raw.cpuPercent,
            memoryMB: raw.memoryMB,
          },
          // New target to approach
          target: {
            cpuPercent: raw.cpuPercent,
            memoryMB: raw.memoryMB,
          },
          // Network is cumulative - just use latest value (no interpolation)
          network: raw.network,
          lastSampleTime: Date.now(),
          exists: raw.exists,
        });
      } catch {
        // Process may have exited
        this.interpolatedMetrics.delete(agentId);
      }
    }
  }

  /**
   * Interpolate current values toward target values
   * Called each render tick (100ms) for smooth visual updates
   * @private
   */
  _interpolateMetrics() {
    for (const [, data] of this.interpolatedMetrics) {
      if (!data.target || !data.current) continue;

      // Lerp CPU and RAM toward target (they fluctuate)
      data.current.cpuPercent = this._lerp(data.current.cpuPercent, data.target.cpuPercent);
      data.current.memoryMB = this._lerp(data.current.memoryMB, data.target.memoryMB);
      // Network is cumulative counter - no interpolation, just use latest
    }
  }

  /**
   * Linear interpolation helper
   * Moves current 15% of the way toward target each tick
   * At 100ms ticks: reaches ~87% of target after 1 second
   * @param {number} current - Current displayed value
   * @param {number} target - Target measured value
   * @returns {number} New interpolated value
   * @private
   */
  _lerp(current, target) {
    if (current === null || current === undefined) return target;
    if (target === null || target === undefined) return current;
    const diff = target - current;
    return current + diff * this.interpolationSpeed;
  }

  /**
   * Get status icon for agent state
   * Uses blinking dot for active states (executing, evaluating, building_context)
   * @param {string} state
   * @returns {string}
   */
  getAgentIcon(state) {
    // Blinking indicator for active states - alternates between bright and dim
    const blinkOn = `${COLORS.green}●${COLORS.reset}`;
    const blinkOff = `${COLORS.dim}○${COLORS.reset}`;
    const blinkIndicator = this.blinkState ? blinkOn : blinkOff;

    switch (state) {
      case 'idle':
        return `${COLORS.gray}○${COLORS.reset}`; // Waiting for trigger
      case 'evaluating_logic':
        return blinkIndicator; // Evaluating triggers (blinking)
      case 'building_context':
        return blinkIndicator; // Building context (blinking)
      case 'executing_task':
        return blinkIndicator; // Running task (blinking)
      case 'stopped':
        return `${COLORS.gray}■${COLORS.reset}`; // Stopped
      case 'error':
        return `${COLORS.red}●${COLORS.reset}`; // Error
      default:
        return `${COLORS.gray}○${COLORS.reset}`;
    }
  }

  /**
   * Format duration in human-readable form
   * @param {number} ms
   * @returns {string}
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Format bytes in human-readable form
   * @param {number} bytes
   * @returns {string}
   */
  formatBytes(bytes) {
    if (bytes < 1024) {
      return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)}KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  }

  /**
   * Render the footer
   * ROBUST: Uses render lock to prevent concurrent renders from corrupting state
   */
  render() {
    if (!this.enabled || !this.isTTY()) return;

    // Graceful degradation: don't render if hidden
    if (this.hidden) return;

    // Render lock: prevent concurrent renders
    if (this.isRendering) {
      return;
    }
    this.isRendering = true;

    // Toggle blink state for visual pulse effect on executing agents
    this.blinkState = !this.blinkState;

    try {
      const { rows, cols } = this.getTerminalSize();

      // Double-check terminal size (may have changed since last check)
      if (rows < this.minRows) {
        this.hidden = true;
        this.resetScrollRegion();
        return;
      }

      // Interpolate metrics toward targets (called every 100ms for smooth visuals)
      // Background sampler updates targets every 500ms
      this._interpolateMetrics();

      // Get executing agents for display
      const executingAgents = Array.from(this.agents.entries())
        .filter(([, agent]) => ACTIVE_STATES.has(agent.state))
        .slice(0, this.maxAgentRows);

      // Calculate dynamic footer height: header + agent rows + summary
      // Minimum 3 lines (header + "no agents" message + summary)
      const agentRowCount = Math.max(1, executingAgents.length);
      const newHeight = 2 + agentRowCount + 1; // header + agents + summary

      // Update scroll region if height changed
      if (newHeight !== this.footerHeight) {
        this.lastFooterHeight = this.footerHeight;
        this.footerHeight = newHeight;
        this.setupScrollRegion();
      }

      // Build footer lines
      const headerLine = this.buildHeaderLine(cols);
      const agentRows = this.buildAgentRows(executingAgents, cols);
      const summaryLine = this.buildSummaryLine(cols);

      // BUILD ENTIRE OUTPUT INTO SINGLE BUFFER for atomic write
      // This prevents interleaving with other processes writing to stdout
      let buffer = '';
      buffer += SAVE_CURSOR;
      buffer += HIDE_CURSOR;

      // Render from top of footer area
      let currentRow = rows - this.footerHeight + 1;

      // Header line
      buffer += this._moveToStr(currentRow++, 1);
      buffer += CLEAR_LINE;
      buffer += `${COLORS.bgBlack}${headerLine}${COLORS.reset}`;

      // Agent rows
      for (const agentRow of agentRows) {
        buffer += this._moveToStr(currentRow++, 1);
        buffer += CLEAR_LINE;
        buffer += `${COLORS.bgBlack}${agentRow}${COLORS.reset}`;
      }

      // Summary line (with bottom border)
      buffer += this._moveToStr(currentRow, 1);
      buffer += CLEAR_LINE;
      buffer += `${COLORS.bgBlack}${summaryLine}${COLORS.reset}`;

      buffer += RESTORE_CURSOR;
      buffer += SHOW_CURSOR;

      // SINGLE ATOMIC WRITE - prevents interleaving
      process.stdout.write(buffer);
    } finally {
      this.isRendering = false;

      // CRITICAL: Position cursor at bottom of scroll region before flushing
      // Without this, output goes below footer if cursor was restored outside scroll region
      // (RESTORE_CURSOR at line 527 may restore to row outside the scrollable area)
      if (this.scrollRegionSet) {
        const { rows } = this.getTerminalSize();
        const scrollEnd = rows - this.footerHeight;
        process.stdout.write(this._moveToStr(scrollEnd, 1));
      }

      // Flush any output that was queued during render
      // Must happen BEFORE pending resize to preserve output order
      this._flushPrintQueue();

      // Process pending resize if one was queued during render
      if (this.pendingResize) {
        this.pendingResize = false;
        // Use setImmediate to avoid deep recursion
        setImmediate(() => this._handleResize());
      }
    }
  }

  /**
   * Build the header line with cluster ID
   * @param {number} width - Terminal width
   * @returns {string}
   */
  buildHeaderLine(width) {
    let content = `${COLORS.gray}┌─${COLORS.reset}`;

    // Cluster ID
    if (this.clusterId) {
      const shortId = this.clusterId.replace('cluster-', '');
      content += ` ${COLORS.cyan}${COLORS.bold}${shortId}${COLORS.reset} `;
    }

    if (this.runMode) {
      content += `${COLORS.dim}[${this.runMode}]${COLORS.reset} `;
    }

    // Fill with border
    const contentLen = this.stripAnsi(content).length;
    const padding = Math.max(0, width - contentLen - 1);
    return content + `${COLORS.gray}${'─'.repeat(padding)}┐${COLORS.reset}`;
  }

  /**
   * Build agent rows (one row per executing agent)
   * @param {Array} executingAgents - Array of [agentId, agent] pairs
   * @param {number} width - Terminal width
   * @returns {Array<string>} Array of formatted rows
   */
  buildAgentRows(executingAgents, width) {
    if (executingAgents.length === 0) {
      // No agents row
      const content = `${COLORS.gray}│${COLORS.reset}  ${COLORS.dim}No active agents${COLORS.reset}`;
      const contentLen = this.stripAnsi(content).length;
      const padding = Math.max(0, width - contentLen - 1);
      return [content + ' '.repeat(padding) + `${COLORS.gray}│${COLORS.reset}`];
    }

    const rows = [];
    for (const [agentId, agent] of executingAgents) {
      const icon = this.getAgentIcon(agent.state);
      const data = this.interpolatedMetrics.get(agentId);
      const metrics = data?.current;

      // Build columns with fixed widths for alignment
      const iconCol = icon;
      const nameCol = agentId.padEnd(14).slice(0, 14); // Max 14 chars for name

      let metricsStr = '';
      if (metrics && data.exists) {
        const cpuColor = metrics.cpuPercent > 50 ? COLORS.yellow : COLORS.green;
        const cpuVal = `${metrics.cpuPercent.toFixed(1)}%`.padStart(6);
        const ramVal = `${metrics.memoryMB.toFixed(1)}MB`.padStart(8);

        metricsStr += `${COLORS.dim}CPU:${COLORS.reset}${cpuColor}${cpuVal}${COLORS.reset}`;
        metricsStr += `  ${COLORS.dim}RAM:${COLORS.reset}${COLORS.gray}${ramVal}${COLORS.reset}`;

        // Network bytes (cumulative - no interpolation)
        const net = data.network;
        if (net && (net.bytesSent > 0 || net.bytesReceived > 0)) {
          const sent = this.formatBytes(net.bytesSent).padStart(7);
          const recv = this.formatBytes(net.bytesReceived).padStart(7);
          metricsStr += `  ${COLORS.dim}NET:${COLORS.reset}${COLORS.cyan}↑${sent} ↓${recv}${COLORS.reset}`;
        }
      } else {
        metricsStr = `${COLORS.dim}(starting...)${COLORS.reset}`;
      }

      // Iteration number
      const iterStr = agent.iteration > 0 ? `${COLORS.dim}#${agent.iteration}${COLORS.reset}` : '';

      // Build the row
      let content = `${COLORS.gray}│${COLORS.reset}  ${iconCol} ${COLORS.white}${nameCol}${COLORS.reset}  ${metricsStr}`;
      if (iterStr) {
        content += `  ${iterStr}`;
      }

      const contentLen = this.stripAnsi(content).length;
      const padding = Math.max(0, width - contentLen - 1);
      rows.push(content + ' '.repeat(padding) + `${COLORS.gray}│${COLORS.reset}`);
    }

    return rows;
  }

  /**
   * Build a single status line for testing/display
   * Alias for buildSummaryLine for backward compatibility
   * @param {number} width - Terminal width
   * @returns {string}
   */
  buildStatusLine(width) {
    return this.buildSummaryLine(width);
  }

  /**
   * Build the summary line with aggregated metrics
   * @param {number} width - Terminal width
   * @returns {string}
   */
  buildSummaryLine(width) {
    const parts = [];

    // Border with corner
    parts.push(`${COLORS.gray}└─${COLORS.reset}`);

    this.appendClusterStateSummary(parts);
    this.appendDurationSummary(parts);
    this.appendAgentCountSummary(parts);
    this.appendTokenCostSummary(parts);
    this.appendAggregateMetricsSummary(parts);

    // Pad and close with bottom corner
    return this.padSummaryLine(parts, width);
  }

  appendClusterStateSummary(parts) {
    const stateColor = this.clusterState === 'running' ? COLORS.green : COLORS.yellow;
    parts.push(` ${stateColor}${this.clusterState}${COLORS.reset}`);
  }

  appendDurationSummary(parts) {
    const duration = this.formatDuration(Date.now() - this.startTime);
    parts.push(` ${COLORS.gray}│${COLORS.reset} ${COLORS.dim}${duration}${COLORS.reset}`);
  }

  appendAgentCountSummary(parts) {
    const { executing, total } = this.getActiveAgentCounts();
    parts.push(
      ` ${COLORS.gray}│${COLORS.reset} ${COLORS.green}${executing}/${total}${COLORS.reset} active`
    );
  }

  getActiveAgentCounts() {
    const executing = Array.from(this.agents.values()).filter((a) =>
      ACTIVE_STATES.has(a.state)
    ).length;
    return { executing, total: this.agents.size };
  }

  appendTokenCostSummary(parts) {
    const costStr = this.getTokenCostSummary();
    if (!costStr) {
      return;
    }
    parts.push(` ${COLORS.gray}│${COLORS.reset} ${COLORS.yellow}${costStr}${COLORS.reset}`);
  }

  getTokenCostSummary() {
    if (!this.messageBus || !this.clusterId) {
      return null;
    }

    try {
      const tokensByRole = this.messageBus.getTokensByRole(this.clusterId);
      const totalCost = tokensByRole?._total?.totalCostUsd || 0;
      if (totalCost <= 0) {
        return null;
      }

      // Format: $0.05 or $1.23 or $12.34
      return totalCost < 0.01 ? '<$0.01' : `$${totalCost.toFixed(2)}`;
    } catch {
      // Ignore errors - token tracking is optional
      return null;
    }
  }

  appendAggregateMetricsSummary(parts) {
    const { totalCpu, totalMem, totalBytesSent, totalBytesReceived } = this.getAggregateMetrics();

    if (totalCpu <= 0 && totalMem <= 0) {
      return;
    }

    parts.push(` ${COLORS.gray}│${COLORS.reset}`);
    let aggregateStr = ` ${COLORS.cyan}Σ${COLORS.reset} `;
    aggregateStr += `${COLORS.dim}CPU:${COLORS.reset}${totalCpu.toFixed(1)}%`;
    aggregateStr += ` ${COLORS.dim}RAM:${COLORS.reset}${totalMem.toFixed(1)}MB`;
    if (totalBytesSent > 0 || totalBytesReceived > 0) {
      aggregateStr += ` ${COLORS.dim}NET:${COLORS.reset}${COLORS.cyan}↑${this.formatBytes(totalBytesSent)} ↓${this.formatBytes(totalBytesReceived)}${COLORS.reset}`;
    }
    parts.push(aggregateStr);
  }

  getAggregateMetrics() {
    let totalCpu = 0;
    let totalMem = 0;
    let totalBytesSent = 0;
    let totalBytesReceived = 0;

    // Aggregate metrics (using interpolated values for smooth display)
    for (const data of this.interpolatedMetrics.values()) {
      if (!data.exists || !data.current) {
        continue;
      }

      totalCpu += data.current.cpuPercent;
      totalMem += data.current.memoryMB;
      totalBytesSent += data.network?.bytesSent || 0;
      totalBytesReceived += data.network?.bytesReceived || 0;
    }

    return { totalCpu, totalMem, totalBytesSent, totalBytesReceived };
  }

  padSummaryLine(parts, width) {
    const content = parts.join('');
    const contentLen = this.stripAnsi(content).length;
    const padding = Math.max(0, width - contentLen - 1);
    return content + `${COLORS.gray}${'─'.repeat(padding)}┘${COLORS.reset}`;
  }

  /**
   * Strip ANSI codes from string for length calculation
   * @param {string} str
   * @returns {string}
   */
  stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  /**
   * Start the status footer
   */
  start() {
    if (!this.enabled || !this.isTTY()) {
      return;
    }

    // Initialize dimension tracking
    const { rows, cols } = this.getTerminalSize();
    this.lastKnownRows = rows;
    this.lastKnownCols = cols;

    // Check for graceful degradation at startup
    if (rows < this.minRows) {
      this.hidden = true;
      return; // Don't set up scroll region for tiny terminals
    }

    this.setupScrollRegion();

    // Handle terminal resize with debounced handler
    process.stdout.on('resize', this._debouncedResize);

    // Start background metrics sampling (every 500ms)
    // Non-blocking - updates target values that display will interpolate toward
    this.samplingIntervalId = setInterval(() => {
      this._sampleMetrics().catch(() => {
        // Ignore sampling errors - display will show stale data
      });
    }, this.samplingInterval);

    // Initial metrics sample (async, don't block startup)
    this._sampleMetrics().catch(() => {});

    // Start display refresh interval (every 100ms - 10 fps)
    // Interpolates current values toward targets for smooth visual updates
    this.intervalId = setInterval(() => {
      if (this.isRendering) return;
      this.render();
    }, this.refreshInterval);

    // Initial render
    this.render();
  }

  /**
   * Stop the status footer and cleanup
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Stop background metrics sampling
    if (this.samplingIntervalId) {
      clearInterval(this.samplingIntervalId);
      this.samplingIntervalId = null;
    }

    // Remove resize listener
    process.stdout.removeListener('resize', this._debouncedResize);

    // ALWAYS perform cleanup if TTY, regardless of hidden state
    // BUG FIX: Previously skipped cleanup when hidden=true, but footer content
    // may still be rendered from before terminal was resized small.
    // The cleanup operations are harmless if footer was never rendered.
    if (this.isTTY()) {
      // BUILD SINGLE BUFFER for atomic shutdown write
      // Prevents interleaving with agent output during cleanup
      let buffer = '';

      // CRITICAL: Clear footer area BEFORE resetting scroll region
      // While scroll region is active, footer area contains only status bar content
      // After reset, those lines may contain scrolled output (which we DON'T want to clear)
      buffer += this._clearFooterAreaStr();

      // Now reset scroll region (full terminal is scrollable again)
      buffer += this._resetScrollRegionStr();
      this.scrollRegionSet = false;

      // Move cursor to safe position and show cursor
      const { rows } = this.getTerminalSize();
      const startRow = rows - this.footerHeight + 1;
      buffer += this._moveToStr(startRow, 1);
      buffer += SHOW_CURSOR;

      // SINGLE ATOMIC WRITE
      process.stdout.write(buffer);
    }
  }

  /**
   * Temporarily hide footer for clean output
   */
  hide() {
    if (!this.isTTY()) return;

    // Single atomic write for hide operation
    // CRITICAL: Clear footer BEFORE resetting scroll region (same reason as stop())
    let buffer = this._clearFooterAreaStr();
    buffer += this._resetScrollRegionStr();
    this.scrollRegionSet = false;
    process.stdout.write(buffer);
  }

  /**
   * Restore footer after hiding
   */
  show() {
    if (!this.isTTY()) return;

    // Reset hidden state and check terminal size
    const { rows } = this.getTerminalSize();
    if (rows < this.minRows) {
      this.hidden = true;
      return;
    }

    this.hidden = false;
    this.setupScrollRegion();
    this.render();
  }
}

/**
 * Create a singleton footer instance
 * @param {Object} options
 * @returns {StatusFooter}
 */
function createStatusFooter(options = {}) {
  return new StatusFooter(options);
}

module.exports = {
  StatusFooter,
  createStatusFooter,
  AGENT_STATE,
  ACTIVE_STATES,
};
