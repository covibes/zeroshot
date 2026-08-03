import { TargetProtocolError } from './errors.mjs';
export function requestUrl(path, descriptor) {
    const url = new globalThis.URL(path, descriptor.capsule.baseUrl);
    if (url.origin !== descriptor.origin || url.hash ||
        `${url.pathname}${url.search}` !== path) {
        throw new TargetProtocolError('Capsule route changed during URL canonicalization');
    }
    return url;
}
