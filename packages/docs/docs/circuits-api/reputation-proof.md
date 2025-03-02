---
title: ReputationProof
---

Inherits: [`BaseProof`](base-proof)

A class representing a [reputation proof](circuits.md#reputation-proof). Each of the following are accessible as properties on the object.

```ts
import { ReputationProof } from '@unirep/circuits'

const data = new ReputationProof(publicSignals, proof)
```

## epochKey

The epoch key that owns the reputation.

```ts
this.epochKey
```

## stateTreeRoot

The state tree root the user is a member of.

```ts
this.stateTreeRoot
```

## nonce

The nonce of the epoch key being proven. This value is only set if `revealNonce` is truthy.

```ts
this.nonce
```

## revealNonce

An integer indicating whether or not the nonce should be revealed. If this value is non-zero the nonce is revealed.

```ts
this.revealNonce
```

## epoch

The epoch the user is proving membership in.

```ts
this.epoch
```

## attesterId

The attester id for the proof.

```ts
this.attesterId
```

## chainId

The chain id for the proof.

```ts
this.chainId
```

## data

The signature data included for the proof.

```ts
this.data
```

## minRep

A minimum amount of net positive reputation the user controls. This value is only used if `proveMinRep` is non-zero.

Example: Alice has 10 `posRep` and 5 `negRep`. Alice can prove a `minRep` of 2 because she has a net positive reputation of 5.

```ts
this.minRep
```

## proveMinRep

Whether or not to enforce the provided `minRep` value. If this value is non-zero the `minRep` will be proven.

```ts
this.proveMinRep
```

## maxRep

A maximum amount of net positive reputation the user controls. This value is only used if `proveMaxRep` is non-zero.

Example: Bob has 10 `posRep` and 5 `negRep`. Bob can prove a `maxRep` of 7 because he has a net positive reputation of 5.

```ts
this.maxRep
```

## proveMaxRep

Whether or not to enforce the provided `maxRep` value. If this value is non-zero the `maxRep` will be proven.

```ts
this.proveMaxRep
```

## proveZeroRep

Whether or not to prove the user has a net 0 reputation balance. If this value is non-zero the user `posRep` and `negRep` must be equal.

```ts
this.proveZeroRep
```

## proveGraffiti

Whether the user has chosen to prove a graffiti. If this value is non-zero the user graffiti will be proven.

```ts
this.proveGraffiti
```

## graffiti

The graffiti controlled by the user, which is defined by `data[SUM_FIELD_COUNT] % (2 ** REPL_NONCE_BITS)` in the circuits. This value is only checked if `proveGraffiti` is non-zero.

```ts
this.graffiti
```

## control

The control field used for the proof. This field contains many signals binary encoded into an array of 256 bit values. This value is automatically decoded into the other properties on this class. See the [circuit documentation](circuits#reputation-proof) for more information.

```ts
this.control0
this.control1
```

## buildControl

Build control from the following parameters:
- `nonce`: `any`
- `epoch`: `any`
- `attesterId`: `any`
- `revealNonce`: `any`
- `chainId`: `any`
- `proveGraffiti`: `any`
- `minRep`: `any`
- `maxRep`: `any`
- `proveMinRep`: `any`
- `proveMaxRep`: `any`
- `proveZeroRep`: `any`

```ts
ReputationProof.buildControl({
    attesterId,
    epoch,
    nonce,
    revealNonce,
    chainId,
    proveGraffiti,
    minRep,
    maxRep,
    proveMinRep,
    proveMaxRep,
    proveZeroRep,
})
```
