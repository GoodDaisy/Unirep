---
title: UniRep contract
---

This is the core UniRep contract.

```sol
import { Unirep } from '@unirep/contracts/Unirep.sol';
```

## config

The config that is set in UniRep.

```sol
function config() public view returns (Config memory)
```

## userSignUp

Submit a signup zk proof for a user.

:::caution
`msg.sender` must be the attester.
:::

```sol
function userSignUp(
  uint[] calldata publicSignals,
  uint[8] calldata proof
) public
```

## manualUserSignUp

Sign up a new user by manually supplying an identity commitment and an [identity hash](../utils-api/helpers.md#genidentityhash). The `initialData` should be the values of the user data in the state tree leaf (if non-zero). This is designed to be used by applications that want custom signup proofs.

:::caution
`msg.sender` must be the attester.
:::

```sol
function manualUserSignUp(
  uint48 epoch,
  uint256 identityCommitment,
  uint256 leafIdentityHash,
  uint256[] calldata initialData
) public
```

## attesterSignUp

Register an attester contract. `msg.sender` will become an attester.

:::tip
The `attesterId` is the address of the attester contract. In this case `msg.sender`.
:::

```sol
function attesterSignUp(uint48 epochLength) public
```

## attesterSignUpViaRelayer

Register an attester contract through a relayer. The signature will be recovered and checked if it matches the given `attester` address.

```sol
function attesterSignUpViaRelayer(
  address attester,
  uint48 epochLength,
  bytes calldata signature
) public
```


## attest

Create an attestation to an epoch key. If the current epoch is not the same as `epoch` the transaction will revert.

Apply a change to a user data field at index `fieldIndex`. Changes will be applied using either addition or replacement, depending on which field is selected.

:::caution
`msg.sender` must be the attester.
:::

:::danger
It is expected that the attester will validate an epoch key before performing an attestation. <br/>
To check the validity of an epoch key: <br/>
- [Epoch key proof](../circuits-api/circuits.md#epoch-key-proof) should be valid. (See [`EpochKeyVerifierHelper`](./verifiers/epoch-key-verifier-helper.md)). <br/>
- [State tree root](../protocol/trees.md#state-tree) should exist. (See [`attesterStateTreeRootExists`](#attesterstatetreerootexists)) <br/>
- Epoch should match the current epoch (See: [`attesterCurrentEpoch`](#attestercurrentepoch)) <br/>

All of these must be verified to confirm epoch key validity. Attestations may be lost if these are not verified.
:::

```sol
function attest(
  uint epochKey,
  uint48 epoch,
  uint fieldIndex,
  uint change
) public
```

## userStateTransition

Execute a user state transition using a ZK proof. This will insert a new state tree leaf in the current epoch.

```sol
function userStateTransition(
  uint[] calldata publicSignals,
  uint[8] calldata proof
) public
```

## updateEpochIfNeeded

Update the current epoch if an epoch is over.

```sol
function updateEpochIfNeeded(
  uint160 attesterId
) public returns (uint48 epoch)
```

## decodeSignupControl

Decode the control signal of [signup proof](../circuits-api/signup-proof.md)

```sol
function decodeSignupControl(
  uint256 control
) public pure returns (
  uint160 attesterId,
  uint48 epoch,
  uint48 chainId
)
```

## decodeSignupSignals

Decode all public signals of [signup proof](../circuits-api/signup-proof.md)

```sol
function decodeSignupSignals(
  uint256[] calldata publicSignals
) public pure returns (SignupSignals memory)
```

```sol
struct SignupSignals {
  uint256 stateTreeLeaf;
  uint48 epoch;
  uint160 attesterId;
  uint256 identityCommitment;
}
```

## decodeUserStateTransitionControl

Decode the control signal of [user state transition proof](../circuits-api/user-state-transition-proof.md)

```sol
function decodeUserStateTransitionControl(
  uint256 control
) public pure returns (
  uint160 attesterId, 
  uint48 toEpoch
)
```

## decodeUserStateTransitionSignals

Decode all public signals of [user state transition proof](../circuits-api//user-state-transition-proof.md)

```sol
function decodeUserStateTransitionSignals(
  uint256[] calldata publicSignals
) public pure returns (UserStateTransitionSignals memory)
```

```sol
struct UserStateTransitionSignals {
  uint256 historyTreeRoot;
  uint256 stateTreeLeaf;
  uint48 toEpoch;
  uint160 attesterId;
  uint256[] epochKeys;
}
```

## attesterCurrentEpoch

Get the current epoch number for an attester.

```sol
function attesterCurrentEpoch(
  uint160 attesterId
) public view returns (uint48)
```

## attesterEpochRemainingTime

Get the remaining time, in seconds, for the current epoch for an attester.

```sol
function attesterEpochRemainingTime(
  uint160 attesterId
) public view returns (uint48)
```

## signupVerifier

A contract address for a signup proof verifier. See [IVerifier](verifiers/iverifier-sol) for more info.

```sol
IVerifier public immutable signupVerifier;
```

## userStateTransitionVerifier

A contract address for a user state transition proof verifier. See [IVerifier](verifiers/iverifier-sol) for more info.

```sol
IVerifier public immutable userStateTransitionVerifier;
```

## attesterStartTimestamp

Get the start timestamp for an attester (in seconds). This is the start of the 0th epoch.

```sol
function attesterStartTimestamp(uint160 attesterId)
  public
  view
  returns (uint256)
```

## attesterEpochLength

Get the epoch length for an attester.

```sol
function attesterEpochLength(uint160 attesterId)
  public
  view
  returns (uint48)
```

## attesterStateTreeRootExists

Check if a state tree root exists for an attester and epoch.

```sol
function attesterStateTreeRootExists(
  uint160 attesterId,
  uint48 epoch,
  uint256 root
) public view returns (bool)
```

## attesterStateTreeRoot

Get the state tree root for an attester for the current epoch.

```sol
function attesterStateTreeRoot(uint160 attesterId)
  public
  view
  returns (uint256)
```

## attesterStateTreeLeafCount

Get the number of state tree leaves for an attester for the current epoch.

```sol
function attesterStateTreeLeafCount(uint160 attesterId)
  public
  view
  returns (uint256)
```

## attesterSemaphoreGroupRoot

Get the Semaphore group root for an attester.

```sol
function attesterSemaphoreGroupRoot(uint160 attesterId)
  public
  view
  returns (uint256)
```

## attesterMemberCount

Get the number of members in the attester Semaphore group.

```sol
function attesterMemberCount(uint160 attesterId)
  public
  view
  returns (uint256)
```

## attesterEpochRoot

Get the epoch tree root for an attester for a certain epoch.

```sol
function attesterEpochRoot(uint160 attesterId, uint48 epoch)
  public
  view
  returns (uint256)
```

## stateTreeDepth

Get the state tree depth for the UniRep contract.

```sol
function stateTreeDepth() public view returns (uint8)
```

## epochTreeDepth

Get the epoch tree depth for the UniRep contract.

```sol
function epochTreeDepth() public view returns (uint8)
```

## historyTreeDepth

Get the history tree depth for the UniRep contract.

```sol
function historyTreeDepth() public view returns (uint8)
```

## numEpochKeyNoncePerEpoch

Get the maximum nonce value for an epoch key. This determines the number of epoch keys per epoch.

```sol
function numEpochKeyNoncePerEpoch() public view returns (uint8)
```

## fieldCount

The number of data fields each user has in this UniRep deployment.

```sol
function fieldCount() public view returns (uint8)
```

## sumFieldCount

How many of the data fields are combined with addition. The sum fields are the first `sumFieldCount` fields in the user data.

```sol
function sumFieldCount() public view returns (uint8)
```

## replNonceBits

How many nonce bits are in a replacement data field.

```sol
function replNonceBits() public view returns (uint8)
```

## replFieldBits

How many data bits are in a replacement data field.

```sol
function replFieldBits() public view returns (uint8)
```

## chainid

Current chain ID of the UniRep contract.

```sol
function chainid() public view returns (uint48)
```


## defaultDataHash

The default data hash when a user signs up. It is used to compute a [state tree](../protocol/trees.md#state-tree) leaf

```sol
function defaultDataHash() public view returns (uint256)
```

## attestationCount

The attestation nonce that is used in [replacement data field](../protocol/data.md#replacement-field).

```sol
function attestationCount() public returns (uint48)
```
