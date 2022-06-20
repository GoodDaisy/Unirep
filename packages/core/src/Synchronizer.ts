import { EventEmitter } from 'events'
import { DB, TransactionDB } from 'anondb'
import { ethers } from 'ethers'
import {
    UserTransitionProof,
    Attestation,
    IAttestation,
} from '@unirep/contracts'
import {
    computeEmptyUserStateRoot,
    computeInitUserStateRoot,
    genNewSMT,
    SMT_ONE_LEAF,
} from './utils'
import { Circuit, formatProofForSnarkjsVerification } from '@unirep/circuits'
import {
    hashLeftRight,
    SparseMerkleTree,
    stringifyBigInts,
    unstringifyBigInts,
    IncrementalMerkleTree,
} from '@unirep/crypto'
import { ISettings } from './interfaces'

export interface Prover {
    verifyProof: (
        name: string | Circuit,
        publicSignals: any,
        proof: any
    ) => Promise<Boolean>
}

const encodeBigIntArray = (arr: BigInt[]): string => {
    return JSON.stringify(stringifyBigInts(arr))
}

const decodeBigIntArray = (input: string): bigint[] => {
    return unstringifyBigInts(JSON.parse(input))
}

// For backward compatibility with the old AttestationEvent
// https://github.com/Unirep/contracts/blob/master/contracts/Unirep.sol#L125
const LEGACY_ATTESTATION_TOPIC =
    '0xdbd3d665448fee233664f2b549d5d40b93371f736ecc7f9bc421fe927bf0b376'

export class Synchronizer extends EventEmitter {
    protected _db: DB
    prover: Prover
    provider: any
    unirepContract: ethers.Contract
    public settings: ISettings
    // GST for current epoch
    private _globalStateTree?: IncrementalMerkleTree
    private _defaultGSTLeaf?: BigInt

    private get globalStateTree() {
        if (!this._globalStateTree) {
            throw new Error('Synchronizer: in memory GST not initialized')
        }
        return this._globalStateTree
    }

    /**
     * Maybe we can default the DB argument to an in memory implementation so
     * that downstream packages don't have to worry about it unless they want
     * to persist things?
     **/
    constructor(db: DB, prover: Prover, unirepContract: ethers.Contract) {
        super()
        this._db = db
        this.unirepContract = unirepContract
        this.provider = this.unirepContract.provider
        this.prover = prover
        this.settings = {
            globalStateTreeDepth: 0,
            userStateTreeDepth: 0,
            epochTreeDepth: 0,
            numEpochKeyNoncePerEpoch: 0,
            attestingFee: ethers.utils.parseEther('0'),
            epochLength: 0,
            maxReputationBudget: 0,
        }
    }

    async setup() {
        const treeDepths = await this.unirepContract.treeDepths()
        this.settings.globalStateTreeDepth = treeDepths.globalStateTreeDepth
        this.settings.userStateTreeDepth = treeDepths.userStateTreeDepth
        this.settings.epochTreeDepth = treeDepths.epochTreeDepth
        const attestingFee = await this.unirepContract.attestingFee()
        this.settings.attestingFee = attestingFee
        const maxReputationBudget =
            await this.unirepContract.maxReputationBudget()
        this.settings.maxReputationBudget = maxReputationBudget
        const numEpochKeyNoncePerEpoch =
            await this.unirepContract.numEpochKeyNoncePerEpoch()
        this.settings.numEpochKeyNoncePerEpoch = numEpochKeyNoncePerEpoch
        const epochLength = await this.unirepContract.epochLength()
        this.settings.epochLength = epochLength
        // load the GST for the current epoch
        // assume we're resuming a sync using the same database
        const epoch = await this._db.findMany('Epoch', {
            where: {
                sealed: false,
            },
        })
        if (epoch.length > 1) {
            throw new Error('Multiple unsealed epochs')
        }
        const emptyUserStateRoot = computeEmptyUserStateRoot(
            this.settings.userStateTreeDepth
        )
        this._defaultGSTLeaf = hashLeftRight(BigInt(0), emptyUserStateRoot)
        this._globalStateTree = new IncrementalMerkleTree(
            this.settings.globalStateTreeDepth,
            this._defaultGSTLeaf
        )
        if (epoch.length === 0) {
            // it's a new sync, start with empty GST
            return
        }
        // otherwise load the leaves and insert them
        // TODO: index consistency verification, ensure that indexes are
        // sequential and no entries are skipped, e.g. 1,2,3,5,6,7
        const leaves = await this._db.findMany('GSTLeaf', {
            where: {
                epoch: epoch[0].number,
            },
            orderBy: {
                index: 'asc',
            },
        })
        for (const leaf of leaves) {
            this.globalStateTree.insert(leaf.hash)
        }
    }

    async loadCurrentEpoch() {
        const currentEpoch = await this._db.findOne('Epoch', {
            where: {},
            orderBy: {
                number: 'desc',
            },
        })
        return (
            currentEpoch || {
                number: 1,
                sealed: false,
            }
        )
    }

    private async _checkCurrentEpoch(epoch: number) {
        const currentEpoch = await this.loadCurrentEpoch()
        if (epoch !== currentEpoch.number) {
            throw new Error(
                `Synchronizer: Epoch (${epoch}) must be the same as the current epoch ${currentEpoch.number}`
            )
        }
    }

    private async _checkValidEpoch(epoch: number) {
        const currentEpoch = await this.loadCurrentEpoch()
        if (epoch > currentEpoch.number) {
            throw new Error(
                `Synchronizer: Epoch (${epoch}) must be less than the current epoch ${currentEpoch.number}`
            )
        }
    }

    private async _checkEpochKeyRange(epochKey: string) {
        if (BigInt(epochKey) >= BigInt(2 ** this.settings.epochTreeDepth)) {
            throw new Error(
                `Synchronizer: Epoch key (${epochKey}) greater than max leaf value(2**epochTreeDepth)`
            )
        }
    }

    private async _isEpochKeySealed(epoch: number, epochKey: string) {
        const _epochKey = await this._db.findOne('EpochKey', {
            where: {
                epoch,
                key: epochKey,
            },
            include: {
                epochDoc: true,
            },
        })
        if (_epochKey && _epochKey?.epochDoc?.sealed) {
            throw new Error(
                `Synchronizer: Epoch key (${epochKey}) has been sealed`
            )
        }
    }

    async genGSTree(epoch: number): Promise<IncrementalMerkleTree> {
        await this._checkValidEpoch(epoch)
        const tree = new IncrementalMerkleTree(
            this.settings.globalStateTreeDepth,
            this._defaultGSTLeaf
        )
        const leaves = await this._db.findMany('GSTLeaf', {
            where: {
                epoch,
            },
            orderBy: {
                index: 'asc',
            },
        })
        for (const leaf of leaves) {
            tree.insert(leaf.hash)
        }
        return tree
    }

    async genEpochTree(epoch: number): Promise<SparseMerkleTree> {
        await this._checkValidEpoch(epoch)
        const treeDepths = await this.unirepContract.treeDepths()
        const epochKeys = await this._db.findMany('EpochKey', {
            where: {
                epoch,
            },
        })
        const epochTreeLeaves = [] as any[]
        for (const epochKey of epochKeys) {
            await this._checkEpochKeyRange(epochKey.key)

            let hashChain: BigInt = BigInt(0)
            const attestations = await this._db.findMany('Attestation', {
                where: {
                    epoch,
                    epochKey: epochKey.key,
                    valid: true,
                },
                orderBy: {
                    index: 'asc',
                },
            })
            for (const attestation of attestations) {
                hashChain = hashLeftRight(attestation.hash, hashChain)
            }
            const sealedHashChainResult = hashLeftRight(BigInt(1), hashChain)
            const epochTreeLeaf = {
                epochKey: BigInt(epochKey.key),
                hashchainResult: sealedHashChainResult,
            }
            epochTreeLeaves.push(epochTreeLeaf)
        }

        const epochTree = genNewSMT(treeDepths.epochTreeDepth, SMT_ONE_LEAF)
        // Add to epoch key hash chain map
        for (let leaf of epochTreeLeaves) {
            epochTree.update(leaf.epochKey, leaf.hashchainResult)
        }
        return epochTree
    }

    async GSTRootExists(
        GSTRoot: BigInt | string,
        epoch: number
    ): Promise<boolean> {
        await this._checkValidEpoch(epoch)
        const found = await this._db.findOne('GSTRoot', {
            where: {
                epoch,
                root: GSTRoot.toString(),
            },
        })
        return !!found
    }

    async epochTreeRootExists(
        _epochTreeRoot: BigInt | string,
        epoch: number
    ): Promise<boolean> {
        await this._checkValidEpoch(epoch)
        const found = await this._db.findOne('Epoch', {
            where: {
                number: epoch,
                epochRoot: _epochTreeRoot.toString(),
            },
        })
        return !!found
    }

    async getNumGSTLeaves(epoch: number) {
        await this._checkValidEpoch(epoch)
        return this._db.count('GSTLeaf', {
            epoch: epoch,
        })
    }

    async nullifierExist(nullifier: BigInt) {
        const count = await this._db.count('Nullifier', {
            nullifier: nullifier.toString(),
        })
        return Boolean(count)
    }

    async getAttestations(epochKey: string): Promise<IAttestation[]> {
        await this._checkEpochKeyRange(epochKey)
        // TODO: transform db entries to IAttestation (they're already pretty similar)
        return this._db.findMany('Attestation', {
            where: {
                epochKey,
                valid: true,
            },
        })
    }

    async getEpochKeys(epoch: number) {
        await this._checkValidEpoch(epoch)

        // db isn't designed to handle epks right now, this is pretty
        // inefficient
        const attestations = await this._db.findMany('Attestation', {
            where: {
                epoch,
            },
        })
        const epks = attestations.reduce((acc, attestation) => {
            return {
                ...acc,
                [attestation.epochKey]: true,
            }
        }, {})
        return Object.keys(epks)
    }

    async start() {
        await this.setup()
        const state = await this._db.findOne('SynchronizerState', {
            where: {},
        })
        if (!state) {
            await this._db.create('SynchronizerState', {
                latestProcessedBlock: 0,
                latestProcessedTransactionIndex: 0,
                latestProcessedEventIndex: 0,
                latestCompleteBlock: 0,
            })
        }
        this.startDaemon()
    }

    async startDaemon() {
        let latestBlock = await this.provider.getBlockNumber()
        this.provider.on('block', (num) => {
            if (num > latestBlock) latestBlock = num
        })
        let latestProcessed = 0
        // TODO: remove this
        // await this._db.create('BlockNumber', {
        //     number: latestProcessed,
        // })
        for (;;) {
            if (latestProcessed === latestBlock) {
                await new Promise((r) => setTimeout(r, 1000))
                continue
            }
            const newLatest = latestBlock
            const allEvents = await this.loadNewEvents(
                latestProcessed + 1,
                newLatest
            )
            const state = await this._db.findOne('SynchronizerState', {
                where: {},
            })
            if (!state) throw new Error('State not initialized')
            // first process historical ones then listen
            const unprocessedEvents = allEvents.filter((e) => {
                if (e.blockNumber === state.latestProcessedBlock) {
                    if (
                        e.transactionIndex ===
                        state.latestProcessedTransactionIndex
                    ) {
                        return e.logIndex > state.latestProcessedEventIndex
                    }
                    return (
                        e.transactionIndex >
                        state.latestProcessedTransactionIndex
                    )
                }
                return e.blockNumber > state.latestProcessedBlock
            })
            await this.processEvents(unprocessedEvents)
            await this._db.update('SynchronizerState', {
                where: {},
                update: {
                    latestCompleteBlock: newLatest,
                },
            })
            latestProcessed = newLatest
        }
    }

    async loadNewEvents(fromBlock, toBlock) {
        return this.unirepContract.queryFilter(
            this.unirepFilter,
            fromBlock,
            toBlock
        )
    }

    // get a function that will process an event for a topic
    get topicHandlers() {
        const [UserSignedUp] = this.unirepContract.filters.UserSignedUp()
            .topics as string[]
        const [UserStateTransitioned] =
            this.unirepContract.filters.UserStateTransitioned()
                .topics as string[]
        const [AttestationSubmitted] =
            this.unirepContract.filters.AttestationSubmitted()
                .topics as string[]
        const [EpochEnded] = this.unirepContract.filters.EpochEnded()
            .topics as string[]
        const [IndexedEpochKeyProof] =
            this.unirepContract.filters.IndexedEpochKeyProof()
                .topics as string[]
        const [IndexedReputationProof] =
            this.unirepContract.filters.IndexedReputationProof()
                .topics as string[]
        const [IndexedUserSignedUpProof] =
            this.unirepContract.filters.IndexedUserSignedUpProof()
                .topics as string[]
        const [IndexedStartedTransitionProof] =
            this.unirepContract.filters.IndexedStartedTransitionProof()
                .topics as string[]
        const [IndexedProcessedAttestationsProof] =
            this.unirepContract.filters.IndexedProcessedAttestationsProof()
                .topics as string[]
        const [IndexedUserStateTransitionProof] =
            this.unirepContract.filters.IndexedUserStateTransitionProof()
                .topics as string[]
        return {
            [UserSignedUp]: this.userSignedUpEvent.bind(this),
            [UserStateTransitioned]: this.USTEvent.bind(this),
            [AttestationSubmitted]: this.attestationEvent.bind(this),
            [LEGACY_ATTESTATION_TOPIC]: this.attestationEvent.bind(this),
            [EpochEnded]: this.epochEndedEvent.bind(this),
            [IndexedEpochKeyProof]: this.epochKeyProofEvent.bind(this),
            [IndexedReputationProof]: this.reputationProofEvent.bind(this),
            [IndexedUserSignedUpProof]: this.userSignedUpProofEvent.bind(this),
            [IndexedStartedTransitionProof]: this.startUSTProofEvent.bind(this),
            [IndexedProcessedAttestationsProof]:
                this.processAttestationProofEvent.bind(this),
            [IndexedUserStateTransitionProof]: this.USTProofEvent.bind(this),
        }
    }

    get unirepFilter() {
        const [UserSignedUp] = this.unirepContract.filters.UserSignedUp()
            .topics as string[]
        const [UserStateTransitioned] =
            this.unirepContract.filters.UserStateTransitioned()
                .topics as string[]
        const [AttestationSubmitted] =
            this.unirepContract.filters.AttestationSubmitted()
                .topics as string[]
        const [EpochEnded] = this.unirepContract.filters.EpochEnded()
            .topics as string[]
        const [IndexedEpochKeyProof] =
            this.unirepContract.filters.IndexedEpochKeyProof()
                .topics as string[]
        const [IndexedReputationProof] =
            this.unirepContract.filters.IndexedReputationProof()
                .topics as string[]
        const [IndexedUserSignedUpProof] =
            this.unirepContract.filters.IndexedUserSignedUpProof()
                .topics as string[]
        const [IndexedStartedTransitionProof] =
            this.unirepContract.filters.IndexedStartedTransitionProof()
                .topics as string[]
        const [IndexedProcessedAttestationsProof] =
            this.unirepContract.filters.IndexedProcessedAttestationsProof()
                .topics as string[]
        const [IndexedUserStateTransitionProof] =
            this.unirepContract.filters.IndexedUserStateTransitionProof()
                .topics as string[]

        return {
            address: this.unirepContract.address,
            topics: [
                [
                    UserSignedUp,
                    UserStateTransitioned,
                    AttestationSubmitted,
                    EpochEnded,
                    IndexedEpochKeyProof,
                    IndexedReputationProof,
                    IndexedUserSignedUpProof,
                    IndexedStartedTransitionProof,
                    IndexedProcessedAttestationsProof,
                    IndexedUserStateTransitionProof,
                    LEGACY_ATTESTATION_TOPIC,
                ],
            ],
        }
    }

    async processEvents(events: ethers.Event[]) {
        if (events.length === 0) return
        events.sort((a: any, b: any) => {
            if (a.blockNumber !== b.blockNumber) {
                return a.blockNumber - b.blockNumber
            }
            if (a.transactionIndex !== b.transactionIndex) {
                return a.transactionIndex - b.transactionIndex
            }
            return a.logIndex - b.logIndex
        })

        for (const event of events) {
            try {
                await this._db.transaction(async (db) => {
                    const handler = this.topicHandlers[event.topics[0]]
                    if (!handler) {
                        console.log(event)
                        throw new Error(
                            `Unrecognized event topic "${event.topics[0]}"`
                        )
                    }
                    await handler(event, db)
                    db.update('SynchronizerState', {
                        where: {},
                        update: {
                            latestProcessedBlock: +event.blockNumber,
                            latestProcessedTransactionIndex:
                                +event.transactionIndex,
                            latestProcessedEventIndex: +event.logIndex,
                        },
                    })
                })
                this.emit(event.topics[0], event)
            } catch (err) {
                console.log(`Error processing event:`, err)
                console.log(event)
                throw err
            }
        }
    }

    // unirep event handlers

    async epochEndedEvent(event: ethers.Event, db: TransactionDB) {
        console.log('update db from epoch ended event: ')
        const epoch = Number(event?.topics[1])
        const treeDepths = await this.unirepContract.treeDepths()
        const tree = await this.genEpochTree(epoch)
        db.upsert('Epoch', {
            where: {
                number: epoch,
            },
            update: {
                sealed: true,
                epochRoot: tree.root.toString(),
            },
            create: {
                number: epoch,
                sealed: true,
                epochRoot: tree.root.toString(),
            },
        })
        // create the next stub entry
        db.create('Epoch', {
            number: epoch + 1,
            sealed: false,
        })
        this._globalStateTree = new IncrementalMerkleTree(
            treeDepths.globalStateTreeDepth,
            this._defaultGSTLeaf
        )
    }

    async attestationEvent(event: ethers.Event, db: TransactionDB) {
        const _epoch = Number(event.topics[1])
        const _epochKey = BigInt(event.topics[2])
        const _attester = event.topics[3]
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'AttestationSubmitted',
            event.data
        )
        const toProofIndex = Number(decodedData.toProofIndex)
        const fromProofIndex = Number(decodedData.fromProofIndex)

        await this._checkCurrentEpoch(_epoch)
        await this._checkEpochKeyRange(_epochKey.toString())
        await this._isEpochKeySealed(_epoch, _epochKey.toString())

        const attestation = new Attestation(
            BigInt(decodedData.attestation.attesterId),
            BigInt(decodedData.attestation.posRep),
            BigInt(decodedData.attestation.negRep),
            BigInt(decodedData.attestation.graffiti),
            BigInt(decodedData.attestation.signUp)
        )
        db.create('Attestation', {
            epoch: _epoch,
            epochKey: _epochKey.toString(),
            index: +`${event.blockNumber}${event.transactionIndex}${event.logIndex}`,
            transactionHash: event.transactionHash,
            attester: _attester,
            proofIndex: toProofIndex,
            attesterId: Number(decodedData.attestation.attesterId),
            posRep: Number(decodedData.attestation.posRep),
            negRep: Number(decodedData.attestation.negRep),
            graffiti: decodedData.attestation.graffiti.toString(),
            signUp: Boolean(Number(decodedData.attestation?.signUp)),
            hash: attestation.hash().toString(),
        })

        const validProof = await this._db.findOne('Proof', {
            where: {
                epoch: _epoch,
                index: toProofIndex,
            },
        })
        if (!validProof) {
            throw new Error('Unable to find proof for attestation')
        }
        if (!validProof.valid) {
            db.update('Attestation', {
                where: {
                    epoch: _epoch,
                    epochKey: _epochKey.toString(),
                    proofIndex: toProofIndex,
                },
                update: {
                    valid: false,
                },
            })
            console.log('Attestion proof is invalid')
            return
        }
        if (fromProofIndex) {
            const fromValidProof = await this._db.findOne('Proof', {
                where: {
                    epoch: _epoch,
                    index: fromProofIndex,
                },
            })
            if (!fromValidProof) {
                throw new Error('Unable to find from proof')
            }
            if (!fromValidProof.valid || fromValidProof.spent) {
                db.update('Attestation', {
                    where: {
                        epoch: _epoch,
                        epochKey: _epochKey.toString(),
                        proofIndex: fromProofIndex,
                    },
                    update: {
                        valid: false,
                    },
                })
                return
            }
            db.update('Proof', {
                where: {
                    epoch: _epoch,
                    index: fromProofIndex,
                },
                update: {
                    spent: true,
                },
            })
        }
        db.update('Attestation', {
            where: {
                epoch: _epoch,
                epochKey: _epochKey.toString(),
                // index: attestIndex,
            },
            update: {
                valid: true,
            },
        })
        db.upsert('EpochKey', {
            where: {
                epoch: _epoch,
                key: _epochKey.toString(),
            },
            update: {},
            create: {
                epoch: _epoch,
                key: _epochKey.toString(),
            },
        })
    }

    async USTEvent(event: ethers.Event, db: TransactionDB) {
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'UserStateTransitioned',
            event.data
        )

        const transactionHash = event.transactionHash
        const epoch = Number(event.topics[1])
        const leaf = BigInt(event.topics[2])
        const proofIndex = Number(decodedData.proofIndex)

        // verify the transition
        const transitionProof = await this._db.findOne('Proof', {
            where: {
                index: proofIndex,
                event: 'IndexedUserStateTransitionProof',
            },
        })
        if (!transitionProof) {
            throw new Error('No transition proof found')
        }
        if (
            !transitionProof.valid ||
            transitionProof.event !== 'IndexedUserStateTransitionProof'
        ) {
            console.log('Transition proof is not valid')
            return
        }
        const startTransitionProof = await this._db.findOne('Proof', {
            where: {
                event: 'IndexedStartedTransitionProof',
                index: transitionProof.proofIndexRecords[0],
            },
        })
        if (!startTransitionProof.valid) {
            console.log(
                'Start transition proof is not valid',
                startTransitionProof.proofIndexRecords[0]
            )
            return
        }
        const { proofIndexRecords } = transitionProof
        if (
            startTransitionProof.blindedUserState !==
                transitionProof.blindedUserState ||
            startTransitionProof.globalStateTree !==
                transitionProof.globalStateTree
        ) {
            console.log(
                'Start Transition Proof index: ',
                proofIndexRecords[0],
                ' mismatch UST proof'
            )
            return
        }

        // otherwise process attestation proofs
        let currentBlindedUserState = startTransitionProof.blindedUserState
        for (let i = 1; i < proofIndexRecords.length; i++) {
            const processAttestationsProof = await this._db.findOne('Proof', {
                where: {
                    event: 'IndexedProcessedAttestationsProof',
                    index: Number(proofIndexRecords[i]),
                },
            })
            if (!processAttestationsProof) {
                return console.log(
                    'Unable to find processed attestations proof'
                )
            }
            if (!processAttestationsProof.valid) {
                console.log(
                    'Process Attestations Proof index: ',
                    proofIndexRecords[i],
                    ' is invalid'
                )
                return
            }
            if (
                currentBlindedUserState !==
                processAttestationsProof.inputBlindedUserState
            ) {
                console.log(
                    'Process Attestations Proof index: ',
                    proofIndexRecords[i],
                    ' mismatch UST proof'
                )
                return
            }
            currentBlindedUserState =
                processAttestationsProof.outputBlindedUserState
        }
        // verify blinded hash chain result
        const { publicSignals, proof } = transitionProof
        const publicSignals_ = decodeBigIntArray(publicSignals)
        const proof_ = JSON.parse(proof)
        const formatProof = new UserTransitionProof(
            publicSignals_,
            formatProofForSnarkjsVerification(proof_)
        )
        for (const blindedHC of formatProof.blindedHashChains) {
            const findBlindHC = await this._db.findOne('Proof', {
                where: {
                    AND: [
                        {
                            outputBlindedHashChain: blindedHC.toString(),
                            event: [
                                'IndexedStartedTransitionProof',
                                'IndexedProcessedAttestationsProof',
                            ],
                        },
                        {
                            index: proofIndexRecords.map((i) => i),
                        },
                    ],
                },
            })
            const inList = proofIndexRecords.indexOf(findBlindHC.index)
            if (inList === -1) {
                console.log(
                    'Proof in UST mismatches proof in process attestations'
                )
                return
            }
        }

        // save epoch key nullifiers
        // check if GST root, epoch tree root exists
        const fromEpoch = Number(formatProof.transitionFromEpoch)
        const gstRoot = formatProof.fromGlobalStateTree.toString()
        const epochTreeRoot = formatProof.fromEpochTree.toString()
        const epkNullifiers = formatProof.epkNullifiers
            .map((n) => n.toString())
            .filter((n) => n !== '0')

        await this._checkValidEpoch(fromEpoch)
        {
            const existingRoot = await this._db.findOne('GSTRoot', {
                where: {
                    epoch: fromEpoch,
                    root: gstRoot,
                },
            })
            if (!existingRoot) {
                console.log('Global state tree root mismatches')
                return
            }
        }
        {
            const existingRoot = await this._db.findOne('Epoch', {
                where: {
                    number: fromEpoch,
                    epochRoot: epochTreeRoot,
                },
            })
            if (!existingRoot) {
                console.log('Epoch tree root mismatches')
                return
            }
        }

        // check and save nullifiers
        const existingNullifier = await this._db.findOne('Nullifier', {
            where: {
                nullifier: epkNullifiers,
                confirmed: true,
            },
        })
        if (existingNullifier) {
            console.log(`duplicated nullifier`)
            return
        }
        // everything checks out, lets start mutating the db
        db.delete('Nullifier', {
            where: {
                nullifier: epkNullifiers,
                confirmed: false,
            },
        })
        db.create(
            'Nullifier',
            epkNullifiers.map((nullifier) => ({
                epoch,
                nullifier,
            }))
        )

        // update GST when new leaf is inserted
        // keep track of each GST root when verifying proofs
        this.globalStateTree.insert(leaf)
        const leafIndexInEpoch = await this._db.count('GSTLeaf', {
            epoch,
        })
        db.create('GSTLeaf', {
            epoch,
            transactionHash,
            hash: leaf.toString(),
            index: leafIndexInEpoch,
        })
        db.create('GSTRoot', {
            epoch,
            root: this.globalStateTree.root.toString(),
        })
    }

    async userSignedUpEvent(event: ethers.Event, db: TransactionDB) {
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'UserSignedUp',
            event.data
        )

        const transactionHash = event.transactionHash
        const epoch = Number(event.topics[1])
        const idCommitment = BigInt(event.topics[2])
        const attesterId = Number(decodedData.attesterId)
        const airdrop = Number(decodedData.airdropAmount)

        const treeDepths = await this.unirepContract.treeDepths()

        await this._checkCurrentEpoch(epoch)
        const USTRoot = computeInitUserStateRoot(
            treeDepths.userStateTreeDepth,
            attesterId,
            airdrop
        )
        const newGSTLeaf = hashLeftRight(idCommitment, USTRoot)

        // update GST when new leaf is inserted
        // keep track of each GST root when verifying proofs
        this.globalStateTree.insert(newGSTLeaf)
        // save the new leaf
        const leafIndexInEpoch = await this._db.count('GSTLeaf', {
            epoch,
        })
        db.create('GSTLeaf', {
            epoch,
            transactionHash,
            hash: newGSTLeaf.toString(),
            index: leafIndexInEpoch,
        })
        db.create('GSTRoot', {
            epoch,
            root: this.globalStateTree.root.toString(),
        })
    }

    async USTProofEvent(event: ethers.Event, db: TransactionDB) {
        const _proofIndex = Number(event.topics[1])
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'IndexedUserStateTransitionProof',
            event.data
        )
        if (!decodedData) {
            throw new Error('Failed to decode data')
        }
        const args = decodedData.proof
        const proofIndexRecords = decodedData.proofIndexRecords.map((n) =>
            Number(n)
        )

        const emptyArray = []
        const formatPublicSignals = emptyArray
            .concat(
                args.newGlobalStateTreeLeaf,
                args.epkNullifiers,
                args.transitionFromEpoch,
                args.blindedUserStates,
                args.fromGlobalStateTree,
                args.blindedHashChains,
                args.fromEpochTree
            )
            .map((n) => BigInt(n))
        const formattedProof = args.proof.map((n) => BigInt(n))
        const proof = encodeBigIntArray(formattedProof)
        const publicSignals = encodeBigIntArray(formatPublicSignals)
        const isValid = await this.prover.verifyProof(
            Circuit.userStateTransition,
            formatPublicSignals,
            formatProofForSnarkjsVerification(formattedProof)
        )
        const exist = await this.GSTRootExists(
            args.fromGlobalStateTree.toString(),
            Number(args.transitionFromEpoch)
        )

        db.create('Proof', {
            index: _proofIndex,
            proof: proof,
            publicSignals: publicSignals,
            blindedUserState: args.blindedUserStates[0].toString(),
            globalStateTree: args.fromGlobalStateTree.toString(),
            proofIndexRecords: proofIndexRecords,
            transactionHash: event.transactionHash,
            event: 'IndexedUserStateTransitionProof',
            valid: isValid && exist,
        })
    }

    async processAttestationProofEvent(event: ethers.Event, db: TransactionDB) {
        const _proofIndex = Number(event.topics[1])
        const _inputBlindedUserState = BigInt(event.topics[2])
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'IndexedProcessedAttestationsProof',
            event.data
        )
        if (!decodedData) {
            throw new Error('Failed to decode data')
        }
        const _outputBlindedUserState = BigInt(
            decodedData.outputBlindedUserState
        )
        const _outputBlindedHashChain = BigInt(
            decodedData.outputBlindedHashChain
        )

        const formatPublicSignals = [
            _outputBlindedUserState,
            _outputBlindedHashChain,
            _inputBlindedUserState,
        ]
        const formattedProof = decodedData.proof.map((n) => BigInt(n))
        const isValid = await this.prover.verifyProof(
            Circuit.processAttestations,
            formatPublicSignals,
            formatProofForSnarkjsVerification(formattedProof)
        )

        const proof = encodeBigIntArray(formattedProof)

        db.create('Proof', {
            index: _proofIndex,
            outputBlindedUserState: _outputBlindedUserState.toString(),
            outputBlindedHashChain: _outputBlindedHashChain.toString(),
            inputBlindedUserState: _inputBlindedUserState.toString(),
            globalStateTree: '0',
            proof: proof,
            transactionHash: event.transactionHash,
            event: 'IndexedProcessedAttestationsProof',
            valid: isValid,
        })
    }

    async startUSTProofEvent(event: ethers.Event, db: TransactionDB) {
        const _proofIndex = Number(event.topics[1])
        const _blindedUserState = BigInt(event.topics[2])
        const _globalStateTree = BigInt(event.topics[3])
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'IndexedStartedTransitionProof',
            event.data
        )
        if (!decodedData) {
            throw new Error('Failed to decode data')
        }
        const _blindedHashChain = BigInt(decodedData.blindedHashChain)
        const formatPublicSignals = [
            _blindedUserState,
            _blindedHashChain,
            _globalStateTree,
        ]
        const formattedProof = decodedData.proof.map((n) => BigInt(n))
        const isValid = await this.prover.verifyProof(
            Circuit.startTransition,
            formatPublicSignals,
            formatProofForSnarkjsVerification(formattedProof)
        )

        const proof = encodeBigIntArray(formattedProof)

        db.create('Proof', {
            index: _proofIndex,
            blindedUserState: _blindedUserState.toString(),
            blindedHashChain: _blindedHashChain.toString(),
            globalStateTree: _globalStateTree.toString(),
            proof: proof,
            transactionHash: event.transactionHash,
            event: 'IndexedStartedTransitionProof',
            valid: isValid,
        })
    }

    async userSignedUpProofEvent(event: ethers.Event, db: TransactionDB) {
        const _proofIndex = Number(event.topics[1])
        const _epoch = Number(event.topics[2])
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'IndexedUserSignedUpProof',
            event.data
        )
        if (!decodedData) {
            throw new Error('Failed to decode data')
        }
        const args = decodedData.proof

        const emptyArray = []
        const formatPublicSignals = emptyArray
            .concat(
                args.epoch,
                args.epochKey,
                args.globalStateTree,
                args.attesterId,
                args.userHasSignedUp
            )
            .map((n) => BigInt(n))
        const formattedProof = args.proof.map((n) => BigInt(n))
        const proof = encodeBigIntArray(formattedProof)
        const publicSignals = encodeBigIntArray(formatPublicSignals)
        const isValid = await this.prover.verifyProof(
            Circuit.proveUserSignUp,
            formatPublicSignals,
            formatProofForSnarkjsVerification(formattedProof)
        )
        const exist = await this.GSTRootExists(
            args.globalStateTree.toString(),
            _epoch
        )

        db.create('Proof', {
            index: _proofIndex,
            epoch: _epoch,
            proof: proof,
            publicSignals: publicSignals,
            transactionHash: event.transactionHash,
            globalStateTree: args.globalStateTree.toString(),
            event: 'IndexedUserSignedUpProof',
            valid: isValid && exist,
        })
    }

    async reputationProofEvent(event: ethers.Event, db: TransactionDB) {
        const _proofIndex = Number(event.topics[1])
        const _epoch = Number(event.topics[2])
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'IndexedReputationProof',
            event.data
        )
        if (!decodedData) {
            throw new Error('Failed to decode data')
        }
        const args = decodedData.proof
        const emptyArray = []
        const formatPublicSignals = emptyArray
            .concat(
                args.repNullifiers,
                args.epoch,
                args.epochKey,
                args.globalStateTree,
                args.attesterId,
                args.proveReputationAmount,
                args.minRep,
                args.proveGraffiti,
                args.graffitiPreImage
            )
            .map((n) => BigInt(n))
        const formattedProof = args.proof.map((n) => BigInt(n))
        const proof = encodeBigIntArray(formattedProof)
        const publicSignals = encodeBigIntArray(formatPublicSignals)
        const isValid = await this.prover.verifyProof(
            Circuit.proveReputation,
            formatPublicSignals,
            formatProofForSnarkjsVerification(formattedProof)
        )
        const exist = await this.GSTRootExists(
            args.globalStateTree.toString(),
            _epoch
        )
        const repNullifiers = args.repNullifiers
            .map((n) => BigInt(n).toString())
            .filter((n) => n !== '0')

        const existingNullifier = await this._db.findOne('Nullifier', {
            where: {
                nullifier: repNullifiers,
                confirmed: true,
            },
        })
        if (existingNullifier) {
            console.log('Duplicate reputation proof nullifier')
        } else {
            // everything checks out, lets start mutating the db
            db.delete('Nullifier', {
                where: {
                    nullifier: repNullifiers,
                    confirmed: false,
                },
            })
            db.create(
                'Nullifier',
                repNullifiers.map((nullifier) => ({
                    epoch: _epoch,
                    nullifier,
                }))
            )
        }
        db.create('Proof', {
            index: _proofIndex,
            epoch: _epoch,
            proof: proof,
            publicSignals: publicSignals,
            transactionHash: event.transactionHash,
            globalStateTree: args.globalStateTree.toString(),
            event: 'IndexedReputationProof',
            valid: isValid && exist && !existingNullifier,
        })
    }

    async epochKeyProofEvent(event: ethers.Event, db: TransactionDB) {
        const _proofIndex = Number(event.topics[1])
        const _epoch = Number(event.topics[2])
        const decodedData = this.unirepContract.interface.decodeEventLog(
            'IndexedEpochKeyProof',
            event.data
        )
        if (!decodedData) {
            throw new Error('Failed to decode data')
        }
        const args = decodedData.proof

        const emptyArray = []
        const formatPublicSignals = emptyArray
            .concat(args.globalStateTree, args.epoch, args.epochKey)
            .map((n) => BigInt(n))
        const formattedProof = args.proof.map((n) => BigInt(n))
        const proof = encodeBigIntArray(formattedProof)
        const publicSignals = encodeBigIntArray(formatPublicSignals)
        const isValid = await this.prover.verifyProof(
            Circuit.verifyEpochKey,
            formatPublicSignals,
            formatProofForSnarkjsVerification(formattedProof)
        )
        const exist = await this.GSTRootExists(
            args.globalStateTree.toString(),
            _epoch
        )

        db.create('Proof', {
            index: _proofIndex,
            epoch: _epoch,
            proof: proof,
            publicSignals: publicSignals,
            transactionHash: event.transactionHash,
            globalStateTree: args.globalStateTree.toString(),
            event: 'IndexedEpochKeyProof',
            valid: isValid && exist,
        })
    }
}
