// Session-launch types for the OMP RPC v2 driver. `none` keeps the Docker-only sessionless launch
// (`--no-session`); `fresh`/`resume` carry a verified partition (and, for resume, a verified
// session file) allocated and checked by the JS task-lib layer — never a raw, unverified path.

export interface VerifiedOmpPartition {
  readonly path: string;
}

export interface VerifiedOmpSessionFile {
  readonly path: string;
}

export type OmpSessionLaunch =
  | { readonly kind: 'none' }
  | { readonly kind: 'fresh'; readonly partition: VerifiedOmpPartition }
  | {
      readonly kind: 'resume';
      readonly partition: VerifiedOmpPartition;
      readonly file: VerifiedOmpSessionFile;
    };
