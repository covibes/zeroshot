"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateAccessUrl = validateAccessUrl;
const errors_js_1 = require("./errors.cjs");
function hasForbiddenCodePoint(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint <= 0x20 || codePoint === 0x7f)
            return true;
    }
    return false;
}
function parseAccessUrl(value) {
    try {
        if (hasForbiddenCodePoint(value))
            throw new TypeError('unsafe URL code point');
        const url = new globalThis.URL(value);
        if (url.href !== value)
            throw new TypeError('non-canonical URL');
        return url;
    }
    catch {
        throw new errors_js_1.TargetProtocolError('Capsule access WebSocket URL is invalid');
    }
}
function matchesAccessRoute(url, target, expectedPath) {
    const expectedProtocol = target.protocol === 'http:' ? 'ws:' : 'wss:';
    return url.protocol === expectedProtocol &&
        url.host === target.host &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === expectedPath;
}
function validateAccessUrl(value, capsuleId, descriptor) {
    const url = parseAccessUrl(value);
    const expectedPath = descriptor.transport.websocketRouteTemplate.expand({
        capsule_id: capsuleId,
    });
    if (!matchesAccessRoute(url, new globalThis.URL(descriptor.origin), expectedPath)) {
        throw new errors_js_1.TargetProtocolError('Capsule access WebSocket URL does not match discovery');
    }
}
