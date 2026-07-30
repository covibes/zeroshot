# Signed validator verdicts

Validator verdicts are the one record in the ledger a third party may later be
asked to rely on: _was this change independently validated before it shipped?_

Today they are rows in SQLite. Anyone who can write the database can change the
answer after the fact, and nothing in the ledger would show it. This feature
signs each verdict when it is recorded and chains it to its predecessor, so
editing, deleting, or reordering verdicts is detectable by someone holding only
the exported receipts and a published keyring.

It is entirely opt-in. A deployment that never constructs a store behaves
exactly as it does today: no signing, no new table, no cost.

## What a verified receipt establishes

> This verdict, with exactly these fields, was signed by the holder of this key
> at this time, and the verified sequence has not been altered since.

## What it does not establish

- That a verdict was correct.
- That the validator was independent or competent. Blind validation is a
  property of how Zeroshot runs validators, not something a signature confers.
- That verdicts signed by a compromised key were honest. Signing binds
  authorship and order, not judgement.
- That no verdict is missing from the front of the sequence. A chain proves
  nothing was removed from the middle or the end of what you hold; it cannot
  prove you were given the beginning.

These limits are returned in every verification report rather than left to a
reader to infer.

## Design

**Provider independence.** Signing happens where verdicts are recorded, so it
behaves identically whether the agent backend is Claude Code, Codex, Gemini, or
a local model. Nothing depends on a hook mechanism owned by one vendor.

**Explicit key trust and rotation.** Keys live in a keyring document with
validity windows and revocation. A verifier resolves the key a receipt names and
checks the receipt falls inside that key's window.

- `not_before` / `not_after` bound when a key may sign.
- Revocation is **not retroactive**. A verdict signed while the key was trusted
  stays valid afterwards, because the alternative silently voids honest history
  every time an operator rotates. A deployment that needs retroactive
  invalidation sets `revoked_at` to the compromise time, which is what that
  field is for.
- The key id is derived from the public key, so a `kid` cannot be reassigned to
  a different key and always checks against the key it names.

**Offline verification.** Verification needs the receipts and a keyring and
nothing else: no running cluster, no network, no vendor service.

**No new dependencies.** Ed25519 via `node:crypto`.

## Usage

```js
const Ledger = require('./src/ledger');
const { VerdictReceiptStore } = require('./src/verdict-receipt-store');
const { generateSigningKey, createKeyring } = require('./src/verdict-receipts');

const ledger = new Ledger('./cluster.db');
const signingKey = generateSigningKey(); // persist private_key_pem securely
const store = new VerdictReceiptStore({ db: ledger.db, signingKey });

store.attach(ledger); // signs every VALIDATION_RESULT from here on
```

Publish only the public half as the keyring your auditors use:

```js
const keyring = createKeyring([
  { kid: signingKey.kid, alg: signingKey.alg, public_key: signingKey.public_key },
]);
```

Export a bundle and verify it anywhere:

```bash
node scripts/verify-verdict-receipts.js \
  --bundle ./verdicts.json \
  --keyring ./keyring.json
```

```
Cluster        demo
Receipts       3
Signatures     3 valid, 0 invalid
Sequence       intact
Trust source   independent keyring

VERIFIED
```

Exit codes: `0` verified, `1` verification failed, `2` usage or input error.

## Attachment modes, and an honest difference

`attach(ledger)` subscribes to the ledger's existing `topic:VALIDATION_RESULT`
event, so no existing code changes. The receipt is written immediately after the
verdict row, **not inside the same transaction**, so a process killed in that
gap can leave a verdict with no receipt.

That gap is reported rather than hidden:

```js
store.findUnsignedVerdicts(clusterId); // verdict rows with no receipt
```

`recordVerdict(message)` is the direct call for callers that want the receipt
written under their own control.

## Refusing rather than guessing

The decision is read from `content.data.approved`, the same field the existing
state reducer treats as the verdict. It must be a real boolean. `"yes"`, `1`,
`"true"` and a missing field all cause the store to refuse to sign.

An unsigned verdict is a visible gap that `findUnsignedVerdicts` will surface. A
confidently signed wrong one is worse, and no amount of later verification would
detect it, because the signature would be perfectly valid over the wrong answer.

Refusals are routed to the store's `onError` callback rather than thrown,
because this runs inside the ledger's `emit`: throwing there would surface as
the failure of an unrelated append and could take down a cluster over a signing
problem.

## Signature and sequence are reported separately

A deleted verdict leaves every remaining signature genuine. Signature checking
alone reports success:

```
Signatures     2 valid, 0 invalid
Sequence       ALTERED
```

These are different failures calling for different responses, so the report
never collapses them into one boolean. One break is also reported once rather
than cascading into every later receipt.

## Trust anchors

The exported bundle carries a `keyring_hint` for convenience. Verifying an
artifact with a key the artifact supplied proves only that it is internally
consistent, and the tool says so in its output when you use it. Use
`--keyring` with an independently obtained keyring for a verification that
means anything.

## Key custody

This module needs a private key and does not care where it comes from.
`generateSigningKey()` is a convenience for getting started, not a
recommendation for production. Where the key lives is the part that determines
what a signature is actually worth, and it is a deployment decision:

- **File or environment variable.** Simplest. The signing key is only as
  protected as the host, so a compromised machine can sign whatever it likes
  from the moment of compromise. Adequate when the threat is later tampering
  with the database rather than compromise at the time of signing.
- **Cloud KMS** (AWS KMS, GCP KMS, Azure Key Vault). The key never leaves the
  service, and you get an independent access log of every signing operation.
  Needs a small adapter, since this module currently signs locally.
- **Hardware token or HSM.** Strongest, and appropriate if verdicts gate
  production changes.
- **A local policy gateway.** A gateway that holds the key and applies policy
  before signing. [protect-mcp](https://www.npmjs.com/package/protect-mcp) is
  one such gateway, MIT licensed.

**Disclosure:** I opened issue #464, I maintain protect-mcp, and I author the
Acta signed-receipts Internet-Draft that its receipt format follows. This
implementation deliberately depends on none of them. It uses `node:crypto` and
adds no dependency, precisely because the triage on #464 asked for something
provider-independent rather than tied to one vendor's tooling. protect-mcp is
listed above as one option among several, not as a recommendation, and nothing
here works differently if you never use it.
