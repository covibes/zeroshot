// Session-launch types for the OMP RPC v2 driver. This slice launches sessionless
// (`--no-session`) only; `fresh`/`resume` are typed for Subissue 4's session-flag activation but
// are unreachable from any caller in this slice.

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
