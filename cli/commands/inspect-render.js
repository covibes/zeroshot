const chalk = require('chalk');

function printProcessHeader(label, processInfo, indent) {
  if (!processInfo) {
    console.log(`${indent}${chalk.dim(label)}: N/A`);
    return false;
  }

  if (!processInfo.metrics?.exists) {
    console.log(`${indent}${chalk.dim(label)}: PID ${processInfo.pid} not running`);
    return false;
  }

  console.log(
    `${indent}${chalk.dim(label)}: PID ${processInfo.pid} · activity ${processInfo.activity}`
  );
  return true;
}

function printProcessResources(metrics, indent) {
  console.log(
    `${indent}  state=${metrics.state} cpu=${metrics.cpuPercent}% mem=${metrics.memoryMB}MB threads=${metrics.threads} children=${metrics.childCount}`
  );
}

function printProcessNetwork(metrics, indent) {
  const established = metrics.network?.established || 0;
  if (established === 0 && !metrics.network?.hasActivity) {
    return;
  }

  console.log(
    `${indent}  net=${established} conn sendQ=${metrics.network.sendQueueBytes} recvQ=${metrics.network.recvQueueBytes} activity=${metrics.network.hasActivity ? 'yes' : 'no'}`
  );
}

function printProcessHealth(processInfo, indent) {
  if (!processInfo.health?.analysis) {
    return;
  }

  console.log(`${indent}  health=${processInfo.health.analysis}`);
}

function printWarnings(warnings, indent = '') {
  if (!warnings || warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    console.log(`${indent}${chalk.yellow(`warning: ${warning}`)}`);
  }
}

function printProcessSection(label, processInfo, indent = '') {
  if (!printProcessHeader(label, processInfo, indent)) {
    return;
  }

  const { metrics } = processInfo;
  printProcessResources(metrics, indent);
  printProcessNetwork(metrics, indent);
  printProcessHealth(processInfo, indent);
}

function printTaskSection(task, indent = '') {
  if (!task) {
    return;
  }

  console.log(
    `${indent}${chalk.dim('Task')}: ${task.id} · ${task.status} · updated ${task.updatedAgeHuman} ago`
  );
  console.log(
    `${indent}  pid=${task.pid || 'N/A'} exit=${task.exitCode ?? 'N/A'} attachable=${task.attachable ? 'yes' : 'no'}`
  );
  console.log(
    `${indent}  log=${task.logFile || 'N/A'} (${task.logFileExists ? 'present' : 'missing'})`
  );
  if (task.error) {
    console.log(`${indent}  ${chalk.red(`error=${task.error}`)}`);
  }
  if (task.socketPath) {
    console.log(
      `${indent}  socket=${task.socketPath} (${task.socketPathExists ? 'present' : 'missing'})`
    );
  }
  printWarnings(task.warnings, `${indent}  `);
}

function printAgentSection(agent) {
  const modelLabel = agent.model ? ` [${agent.model}]` : '';
  console.log(`  - ${agent.id} (${agent.role})${modelLabel}`);
  console.log(
    `    state=${agent.state} iteration=${agent.iteration} runningTask=${agent.currentTask ? 'yes' : 'no'}`
  );
  if (agent.currentTaskId) {
    console.log(`    taskId=${agent.currentTaskId}`);
  }
  printProcessSection('process', agent.process, '    ');
  printTaskSection(agent.task, '    ');
  printWarnings(agent.warnings, '    ');
}

function printClusterInspectionHuman(inspection) {
  console.log(`\nCluster Inspect: ${inspection.id}`);
  console.log(`State: ${inspection.cluster.state}`);
  console.log(`PID: ${inspection.cluster.pid || 'N/A'}`);
  console.log(`Created: ${new Date(inspection.cluster.createdAt).toLocaleString()}`);
  console.log(`Messages: ${inspection.cluster.messageCount}`);
  console.log(`Sample: ${inspection.sampleMs}ms`);

  console.log('\nCluster Process:');
  printProcessSection('process', inspection.process, '  ');

  console.log('\nAgents:');
  for (const agent of inspection.agents) {
    printAgentSection(agent);
  }
  console.log('');
}

function printTaskInspectionHuman(inspection) {
  console.log(`\nTask Inspect: ${inspection.id}`);
  console.log(`Sample: ${inspection.sampleMs}ms`);
  printTaskSection(inspection.task);
  console.log('');
  printProcessSection('Process', inspection.process);
  console.log('');
}

module.exports = {
  printClusterInspectionHuman,
  printProcessSection,
  printTaskInspectionHuman,
  printTaskSection,
  printWarnings,
};
