const { CANCEL_KEYS, fit, gutter, stepHead, terminalWidth } = require('./setup-wizard-terminal');

function formatValue(value) {
  if (typeof value === 'string') return value;
  const serialized = JSON.stringify(value);
  return serialized.length > 44 ? `${serialized.slice(0, 41)}…` : serialized;
}

function writeMarker(write) {
  return write.from === null || write.from === undefined ? '+' : '~';
}

function createPlanState(groups) {
  return {
    status: 'active',
    focus: 0,
    action: 0,
    enabled: Object.fromEntries(groups.map((group) => [group.id, group.enabled !== false])),
  };
}

function movePlanFocus(state, direction, groupCount) {
  const count = groupCount + 1;
  return { ...state, focus: (state.focus + direction + count) % count };
}

function togglePlanGroup(state, group) {
  if (!group || group.required) return state;
  return {
    ...state,
    enabled: { ...state.enabled, [group.id]: !state.enabled[group.id] },
  };
}

function choosePlanAction(state, groups) {
  if (state.focus < groups.length) return { ...state, focus: groups.length };
  return { ...state, status: state.action === 0 ? 'apply' : 'cancelled' };
}

function navigatePlanActions(state, key, groupCount) {
  if (state.focus !== groupCount) return null;
  if (key !== 'left' && key !== 'right') return null;
  return { ...state, action: state.action === 0 ? 1 : 0 };
}

function reducePlanState(state, key, groups) {
  if (state.status !== 'active') return state;
  if (CANCEL_KEYS.has(key)) return { ...state, status: 'cancelled' };
  if (key === 'up') return movePlanFocus(state, -1, groups.length);
  if (key === 'down') return movePlanFocus(state, 1, groups.length);
  const actionNavigation = navigatePlanActions(state, key, groups.length);
  if (actionNavigation) return actionNavigation;
  if (key === 'space') return togglePlanGroup(state, groups[state.focus]);
  return key === 'enter' ? choosePlanAction(state, groups) : state;
}

function planFrame({ stdout, theme, model, state, active = true }) {
  const width = terminalWidth(stdout);
  const targetCount = new Set(model.writes.map((write) => write.targetFile)).size;
  const meta = `${targetCount} ${targetCount === 1 ? 'file' : 'files'} · ${model.writes.length} settings`;
  const rows = [
    stepHead(theme, active ? 'active' : 'done', 'Plan', { meta, width }),
    gutter(theme),
  ];
  model.groups.forEach((group, index) => {
    const selected = active && state.focus === index;
    const enabled = group.required || state.enabled[group.id];
    const cursor = selected ? theme.accent('▸') : ' ';
    const box = enabled ? '[x]' : '[ ]';
    const title = selected ? theme.bold(group.title) : group.title;
    rows.push(
      gutter(
        theme,
        fit(`${cursor} ${box} ${title}${group.required ? ' · required' : ''}`, width - 3)
      )
    );
    if (enabled) {
      for (const write of group.writes) {
        rows.push(
          gutter(
            theme,
            fit(`  ${writeMarker(write)} ${write.path} = ${formatValue(write.to)}`, width - 3)
          )
        );
      }
    }
  });
  if (model.files.length > 0) {
    rows.push(gutter(theme));
    rows.push(gutter(theme, fit(theme.dim(`files: ${model.files.join(', ')}`), width - 3)));
  }
  if (active) {
    const actionFocus = state.focus === model.groups.length;
    const apply = state.action === 0 && actionFocus ? theme.bold('▸ Apply') : theme.dim('  Apply');
    const cancel =
      state.action === 1 && actionFocus ? theme.bold('▸ Cancel') : theme.dim('  Cancel');
    rows.push(gutter(theme));
    rows.push(gutter(theme, fit(`${apply}   ${cancel}`, width - 3)));
    rows.push(
      gutter(theme, fit(theme.dim('↑↓ move · space toggle · ←→ choose · ↵ continue'), width - 3))
    );
  } else {
    rows.push(gutter(theme, theme.dim('approved · writes begin below')));
    rows.push(gutter(theme));
  }
  return rows;
}

async function selectPlan({ stdout, reader, live, theme, buildModel }) {
  let model = buildModel();
  let state = createPlanState(model.groups);
  live.paint(planFrame({ stdout, theme, model, state }));
  while (state.status === 'active') {
    const key = await reader.read();
    state = reducePlanState(state, key, model.groups);
    model = buildModel(state.enabled);
    if (state.status === 'active') live.paint(planFrame({ stdout, theme, model, state }));
  }
  if (state.status === 'apply') {
    live.commit(planFrame({ stdout, theme, model, state, active: false }));
    return { action: 'apply', model, enabled: state.enabled };
  }
  live.clear();
  return { action: 'cancel', model, enabled: state.enabled };
}

function receiptLine(theme, result) {
  if (result.applied) return `${theme.success('v')} ${result.decisionId}`;
  return `${theme.dim('–')} ${result.decisionId} · ${result.skippedReason}`;
}

function applyState(verified, failed) {
  if (failed) return { state: 'failed', meta: 'failed' };
  if (verified) return { state: 'done', meta: 'verified' };
  return { state: 'active', meta: 'writing' };
}

function renderApplyFrame({ stdout, theme, results, verified, failed }) {
  const width = terminalWidth(stdout);
  const { state, meta } = applyState(verified, failed);
  const rows = [stepHead(theme, state, 'Apply', { meta, width }), gutter(theme)];
  for (const result of results) {
    rows.push(gutter(theme, fit(receiptLine(theme, result), width - 3)));
  }
  if (!verified && !failed) rows.push(gutter(theme, theme.dim('writing settings atomically')));
  if (verified) rows.push(gutter(theme, `${theme.success('v')} persisted settings verified`));
  rows.push(gutter(theme));
  return rows;
}

module.exports = {
  createPlanState,
  planFrame,
  reducePlanState,
  renderApplyFrame,
  selectPlan,
};
