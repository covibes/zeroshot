import type { Clock } from './types.js';
export declare function throwCapsuleServerError(response: Response, readJson: (response: Response) => Promise<unknown>, clock: Clock): Promise<never>;
