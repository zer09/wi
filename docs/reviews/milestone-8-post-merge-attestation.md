# Milestone 8 final post-merge attestation

Status: **PASS — all Milestone 8 post-merge gates satisfied**

This record preserves the independently reviewed identities and hosted runtime evidence that authorized Milestone 9. It does not begin or validate Milestone 9.

## Identities

| Item | SHA |
|---|---|
| Approved implementation head | `476baf8b35527fab04d40b52600434d8f064417d` |
| Actual merge/current master at attestation | `e8fc2a30730025f3108cd41d8225876297ad8f90` |

The actual merge tree exactly matched the approved implementation tree and no later default-branch commit existed at attestation.

## Hosted gates

| Gate | Evidence | Result |
|---|---|---|
| Post-merge CI | GitHub Actions run `30342645704`; `checks`, `e2e`, and `required` on exact merge SHA | PASS |
| Controlled hidden artifact | Run `30342865399`, attempt 2, disposable probe `7b0321f8ee7ecbcae78212ebfc507e73d2bcc8e6` | PASS |
| Final clean extended fuzz | Run `30346643948`, exact merge SHA, manual seed `811009` | PASS |

## Controlled artifact

- artifact ID: `8682797746`
- name: `fuzz-counterexamples-30342865399`
- JSON mode: `0600`
- JSON SHA-256: `226a235c1a7be6ae2a1c70ccd51fd40677920167c92913c6bb0eaa0a1e658e73`
- ZIP SHA-256: `0ab65d3915133da0f34103e5a3de0fd8ec2359e5544c96c6748f2fad7def045a`
- seed/path: `2012938465` / `0:0:0`
- counterexample SHA-256: `13cf9382218b465d8490adab0553851b8713aae329e0d81d1827a7c29c9f122d`

The downloaded complete artifact contained no credentials, tokens, authorization headers, cookies, sensitive paths, or unbounded model/tool output. Its exact reproduction command produced the intended single failure with the same seed, path, counterexample, and mode-0600 replay artifact. The disposable probe branch was deleted.

## Final clean run

Run `30346643948` completed ten rounds at seeds `811009..811018`:

- 8 files and 36 passing tests per round;
- 360 successful test invocations;
- measured elapsed `642489ms` for a `600000ms` minimum budget;
- final residual round `18932ms`;
- zero uploaded artifacts;
- no later hosted failure before attestation.

## Closure

Resolved implementation findings: `WI-M8-H1`, `WI-M8-M2`, `WI-M8-M1`, and reproduction-command quoting. Open finding IDs and verification gates: none.

Independent final verdict: **Milestone 8 merged and independently attested; Milestone 9 may begin.**
