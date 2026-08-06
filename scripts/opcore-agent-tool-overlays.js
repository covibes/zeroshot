const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const writeTools = new Set(['write']);
const editTools = new Set(['edit']);
const multiEditTools = new Set(['multiedit', 'multi_edit']);
const applyPatchTools = new Set(['applypatch', 'apply_patch']);
let editApiPromise;

function firstString(...values) {
  return values.find((value) => typeof value === 'string');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstRecord(...values) {
  return values.find(isRecord);
}

function requiredString(value, name) {
  if (value === undefined) throw new Error(`${name} must be a string`);
  return value;
}

function resolveTargetPath(repoRoot, filePath) {
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);
  const relative = path.relative(repoRoot, absolute);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes('..')
  ) {
    throw new Error(`pre-write target must stay inside the repo: ${filePath}`);
  }
  return relative.replaceAll('\\', '/');
}

function extractToolRequest(envelope) {
  const nested = firstRecord(envelope.tool, envelope.toolCall, envelope.tool_call);
  const toolName = firstString(
    envelope.tool_name,
    envelope.toolName,
    envelope.name,
    nested?.name,
    nested?.tool_name,
    nested?.toolName
  );
  if (!toolName) return null;
  return {
    toolName,
    normalizedToolName: toolName.toLowerCase().replaceAll('-', '_'),
    input:
      firstRecord(
        envelope.tool_input,
        envelope.toolInput,
        envelope.input,
        nested?.input,
        nested?.tool_input,
        nested?.toolInput
      ) || envelope,
    cwd: firstString(envelope.cwd),
  };
}

function writeOverlay(repoRoot, input) {
  return {
    action: 'write',
    path: resolveTargetPath(
      repoRoot,
      requiredString(firstString(input.file_path, input.filePath, input.path), 'file_path')
    ),
    content: requiredString(firstString(input.content, input.text), 'content'),
  };
}

function editOverlay(repoRoot, input) {
  const relative = resolveTargetPath(
    repoRoot,
    requiredString(firstString(input.file_path, input.filePath, input.path), 'file_path')
  );
  const oldString = requiredString(firstString(input.old_string, input.oldString), 'old_string');
  const newString = requiredString(firstString(input.new_string, input.newString), 'new_string');
  const existing = fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');
  if (!existing.includes(oldString)) throw new Error(`old_string was not found in ${relative}`);
  return { action: 'write', path: relative, content: existing.replace(oldString, newString) };
}

function multiEditOverlay(repoRoot, input) {
  const relative = resolveTargetPath(
    repoRoot,
    requiredString(firstString(input.file_path, input.filePath, input.path), 'file_path')
  );
  let content = fs.readFileSync(path.resolve(repoRoot, relative), 'utf8');
  for (const edit of Array.isArray(input.edits) ? input.edits : []) {
    if (!isRecord(edit)) throw new Error(`MultiEdit edit for ${relative} must be an object`);
    const oldString = requiredString(firstString(edit.old_string, edit.oldString), 'old_string');
    const newString = requiredString(firstString(edit.new_string, edit.newString), 'new_string');
    if (!content.includes(oldString)) throw new Error(`old_string was not found in ${relative}`);
    content = content.replace(oldString, newString);
  }
  return { action: 'write', path: relative, content };
}

function loadEditApi() {
  if (!editApiPromise) {
    const opcoreEntrypoint = require.resolve('opcore');
    const editModule = path.resolve(
      path.dirname(opcoreEntrypoint),
      '../node_modules/@the-open-engine/opcore-edit/dist/index.js'
    );
    editApiPromise = import(pathToFileURL(editModule).href);
  }
  return editApiPromise;
}

async function patchOverlays(repoRoot, input) {
  const patch = firstString(input.command, input.patch);
  if (!patch) return [];
  const { createNodeEditWorkspace, createPatchEditPlan, isCodexApplyPatch } = await loadEditApi();
  if (!isCodexApplyPatch(patch)) return [];
  const workspace = await createNodeEditWorkspace({ repoRoot });
  const planned = await createPatchEditPlan(workspace, {
    repo: { repoRoot },
    validation: { required: false },
    patch,
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return Object.entries(planned.afterState).flatMap(([filePath, content]) => {
    if (content === undefined) return [];
    return [
      {
        action: content === null ? 'delete' : 'write',
        path: filePath,
        ...(content === null ? {} : { content }),
      },
    ];
  });
}

function overlaysForTool(repoRoot, tool) {
  if (writeTools.has(tool.normalizedToolName)) return [writeOverlay(repoRoot, tool.input)];
  if (editTools.has(tool.normalizedToolName)) return [editOverlay(repoRoot, tool.input)];
  if (multiEditTools.has(tool.normalizedToolName)) return [multiEditOverlay(repoRoot, tool.input)];
  if (applyPatchTools.has(tool.normalizedToolName)) return patchOverlays(repoRoot, tool.input);
  return [];
}

module.exports = { extractToolRequest, isRecord, overlaysForTool };
