import chalk = require('chalk');

interface MessagePrefixData {
  sender: string;
  cluster_id?: string | null;
  sender_model?: string | null;
}

/**
 * Get color for sender based on consistent hashing.
 */
function getColorForSender(sender: string): chalk.Chalk {
  const colors = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green, chalk.blue];
  let hash = 0;
  for (let i = 0; i < sender.length; i++) {
    hash = (hash << 5) - hash + sender.charCodeAt(i);
    hash = hash & hash;
  }
  return colors[Math.abs(hash) % colors.length] ?? chalk.cyan;
}

/**
 * Build message prefix with timestamp, sender, and optional cluster ID.
 */
function buildMessagePrefix(
  msg: MessagePrefixData,
  showClusterId: boolean,
  isActive: boolean
): string {
  const color = isActive ? getColorForSender(msg.sender) : chalk.dim;

  let senderLabel = msg.sender;
  if (showClusterId && msg.cluster_id) {
    senderLabel = `${msg.cluster_id}/${msg.sender}`;
  }

  const modelSuffix = msg.sender_model ? chalk.dim(` [${msg.sender_model}]`) : '';
  return color(`${senderLabel.padEnd(showClusterId ? 25 : 15)} |`) + modelSuffix;
}

/**
 * Build cluster prefix for watch mode.
 */
function buildClusterPrefix(clusterId: string, isActive: boolean): string {
  const color = isActive ? chalk.white : chalk.dim;
  return color(`${clusterId.padEnd(20)} |`);
}

/**
 * Parse and normalize data fields (handles string JSON).
 */
function parseDataField(data: unknown): unknown {
  if (typeof data === 'string') {
    try {
      const parsed: unknown = JSON.parse(data);
      return parsed;
    } catch {
      return [];
    }
  }
  return Array.isArray(data) ? data : [];
}

export = {
  getColorForSender,
  buildMessagePrefix,
  buildClusterPrefix,
  parseDataField,
};
