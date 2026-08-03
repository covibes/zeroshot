"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestUrl = requestUrl;
const errors_js_1 = require("./errors.cjs");
function requestUrl(path, descriptor) {
    const url = new globalThis.URL(path, descriptor.capsule.baseUrl);
    if (url.origin !== descriptor.origin || url.hash ||
        `${url.pathname}${url.search}` !== path) {
        throw new errors_js_1.TargetProtocolError('Capsule route changed during URL canonicalization');
    }
    return url;
}
