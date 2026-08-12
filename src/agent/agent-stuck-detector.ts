import fs = require('fs');

interface SafeExecModule {
  execSync(command: string, options: { encoding: 'utf8'; timeout: number }): string;
}

interface MissingProcessState {
  exists: false;
  error?: unknown;
}

interface PresentProcessState {
  exists: true;
  state: string | undefined;
  wchan: string;
  cpuTicks: number;
  threads: number;
  volCtxSwitches: number;
}

type ProcessState = MissingProcessState | PresentProcessState;

interface ConnectionState {
  state: string;
  recvQ: number;
  sendQ: number;
  local: string;
  peer: string;
}

interface NetworkState {
  hasNetwork: boolean;
  connections?: ConnectionState[];
  establishedCount?: number;
  hasDataInFlight?: boolean;
  hasSynSent?: boolean;
  error?: unknown;
}

interface HealthIndicators {
  isSleeping: boolean;
  isBlockedOnPoll: boolean;
  lowCpuUsage: boolean;
  lowCtxSwitches: boolean;
  noDataInFlight: boolean;
  hasSynSent: boolean | undefined;
}

interface AvailableProcessHealth {
  pid: number;
  state: string | undefined;
  wchan: string;
  cpuPercent: number;
  ctxSwitchesDelta: number;
  threads: number;
  network: {
    hasConnections: boolean;
    establishedCount: number;
    hasDataInFlight: boolean;
    hasSynSent: boolean;
  };
  indicators: HealthIndicators;
  stuckScore: number;
  isLikelyStuck: boolean;
  confidence: 'low' | 'medium' | 'high';
  analysis: string;
}

interface UnavailableProcessHealth {
  isLikelyStuck: null;
  reason: string;
  pid: number;
}

type ProcessHealth = AvailableProcessHealth | UnavailableProcessHealth;

type SocketFields = [string, string, string, string, string];

function isSafeExecModule(value: unknown): value is SafeExecModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'execSync' in value &&
    typeof value.execSync === 'function'
  );
}

function errorMessage(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return error.message;
  }
  return undefined;
}

function parseProcInteger(value: string | undefined): number {
  return value === undefined ? Number.NaN : parseInt(value, 10);
}

function hasSocketFields(fields: string[] | undefined): fields is SocketFields {
  return fields?.length === 5;
}

const STUCK_THRESHOLD = 3.5;
const HIGH_CONFIDENCE_THRESHOLD = 4.5;
const CPU_LOW_THRESHOLD = 1;
const CTX_SWITCHES_LOW_THRESHOLD = 10;

function stuckScoreFor(indicators: HealthIndicators, hasDataInFlight: boolean | undefined): number {
  const score =
    Number(indicators.isSleeping) +
    Number(indicators.isBlockedOnPoll) +
    Number(indicators.lowCpuUsage) +
    Number(indicators.lowCtxSwitches) +
    Number(indicators.noDataInFlight) * 0.5 +
    Number(Boolean(indicators.hasSynSent));
  return hasDataInFlight ? Math.max(0, score - 2) : score;
}

function confidenceFor(stuckScore: number): AvailableProcessHealth['confidence'] {
  if (stuckScore >= HIGH_CONFIDENCE_THRESHOLD) return 'high';
  if (stuckScore >= STUCK_THRESHOLD) return 'medium';
  return 'low';
}

const rawSafeExec: unknown = require('../lib/safe-exec');
if (!isSafeExecModule(rawSafeExec)) {
  throw new TypeError('safe-exec must export execSync');
}
const { execSync } = rawSafeExec;

function getProcessState(pid: number): ProcessState {
  try {
    const statPath = `/proc/${pid}/stat`;
    if (!fs.existsSync(statPath)) {
      return { exists: false };
    }

    const stat = fs.readFileSync(statPath, 'utf8');
    const parts = stat.split(' ');
    const state = parts[2];

    let wchan = '';
    try {
      wchan = fs.readFileSync(`/proc/${pid}/wchan`, 'utf8').trim();
    } catch {
      // wchan may not be readable.
    }

    const utime = parseProcInteger(parts[13]);
    const stime = parseProcInteger(parts[14]);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const threads = /Threads:\s+(\d+)/.exec(status)?.[1] || '1';
    const volCtxSwitches = /voluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1] || '0';

    return {
      exists: true,
      state,
      wchan,
      cpuTicks: utime + stime,
      threads: parseInt(threads, 10),
      volCtxSwitches: parseInt(volCtxSwitches, 10),
    };
  } catch (error: unknown) {
    return { exists: false, error: errorMessage(error) };
  }
}

function getNetworkState(pid: number): NetworkState {
  try {
    const fdPath = `/proc/${pid}/fd`;
    if (!fs.existsSync(fdPath)) {
      return { hasNetwork: false };
    }

    let ssOutput = '';
    try {
      ssOutput = execSync(`ss -tunp 2>/dev/null | grep ",pid=${pid}," || true`, {
        encoding: 'utf8',
        timeout: 5000,
      });
    } catch {
      return { hasNetwork: false };
    }

    if (!ssOutput.trim()) {
      return { hasNetwork: false, connections: [] };
    }

    const connections: ConnectionState[] = [];
    for (const line of ssOutput.trim().split('\n')) {
      const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(line);
      const fields = match?.slice(1, 6);
      if (!hasSocketFields(fields)) continue;
      const [state, recvQ, sendQ, local, peer] = fields;
      connections.push({
        state,
        recvQ: parseInt(recvQ, 10),
        sendQ: parseInt(sendQ, 10),
        local,
        peer,
      });
    }

    return {
      hasNetwork: connections.length > 0,
      connections,
      establishedCount: connections.filter((connection) => connection.state === 'ESTAB').length,
      hasDataInFlight: connections.some(
        (connection) => connection.recvQ > 0 || connection.sendQ > 0
      ),
      hasSynSent: connections.some((connection) => connection.state === 'SYN-SENT'),
    };
  } catch (error: unknown) {
    return { hasNetwork: false, error: errorMessage(error) };
  }
}

async function analyzeProcessHealth(pid: number, samplePeriodMs = 5000): Promise<ProcessHealth> {
  const t0 = getProcessState(pid);
  if (!t0.exists) {
    return { isLikelyStuck: null, reason: 'Process does not exist', pid };
  }

  await new Promise<void>((resolve) => setTimeout(resolve, samplePeriodMs));

  const t1 = getProcessState(pid);
  if (!t1.exists) {
    return { isLikelyStuck: null, reason: 'Process died during analysis', pid };
  }

  const cpuTicksDelta = t1.cpuTicks - t0.cpuTicks;
  const ctxSwitchesDelta = t1.volCtxSwitches - t0.volCtxSwitches;
  const cpuSeconds = cpuTicksDelta / 100;
  const sampleSeconds = samplePeriodMs / 1000;
  const cpuPercent = (cpuSeconds / sampleSeconds) * 100;
  const network = getNetworkState(pid);

  const indicators = {
    isSleeping: t1.state === 'S',
    isBlockedOnPoll: t1.wchan.includes('poll') || t1.wchan.includes('wait'),
    lowCpuUsage: cpuPercent < CPU_LOW_THRESHOLD,
    lowCtxSwitches: ctxSwitchesDelta < CTX_SWITCHES_LOW_THRESHOLD,
    noDataInFlight: network.hasNetwork && !network.hasDataInFlight,
    hasSynSent: network.hasSynSent,
  };

  const stuckScore = stuckScoreFor(indicators, network.hasDataInFlight);
  const isLikelyStuck = stuckScore >= STUCK_THRESHOLD;
  const confidence = confidenceFor(stuckScore);

  return {
    pid,
    state: t1.state,
    wchan: t1.wchan,
    cpuPercent: parseFloat(cpuPercent.toFixed(2)),
    ctxSwitchesDelta,
    threads: t1.threads,
    network: {
      hasConnections: network.hasNetwork,
      establishedCount: network.establishedCount || 0,
      hasDataInFlight: network.hasDataInFlight || false,
      hasSynSent: network.hasSynSent || false,
    },
    indicators,
    stuckScore: parseFloat(stuckScore.toFixed(1)),
    isLikelyStuck,
    confidence,
    analysis: isLikelyStuck
      ? `Process appears STUCK: sleeping on ${t1.wchan}, ${cpuPercent.toFixed(1)}% CPU, ` +
        `${ctxSwitchesDelta} ctx switches`
      : `Process appears WORKING: ${cpuPercent.toFixed(1)}% CPU, ${ctxSwitchesDelta} ctx switches, state=${t1.state}`,
  };
}

function isPlatformSupported(): boolean {
  return process.platform === 'linux' && fs.existsSync('/proc');
}

export = {
  analyzeProcessHealth,
  getProcessState,
  getNetworkState,
  isPlatformSupported,
  STUCK_THRESHOLD,
  HIGH_CONFIDENCE_THRESHOLD,
  CPU_LOW_THRESHOLD,
  CTX_SWITCHES_LOW_THRESHOLD,
};
