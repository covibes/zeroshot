'use strict';

function inputFromRequest(request, artifactManifest) {
  if (request.source === 'issue') return { issue: request.issue };
  if (request.source === 'prompt') return { text: request.prompt };
  return {
    text:
      'Execute the task described by this registry-staged, byte-free artifact manifest. ' +
      'Do not request interactive input.\n' +
      JSON.stringify(artifactManifest),
  };
}

module.exports = { inputFromRequest };
