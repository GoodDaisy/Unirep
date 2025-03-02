// @ts-ignore
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Identity } from '@semaphore-protocol/identity'
import { deployUnirep, deployVerifierHelper } from '@unirep/contracts/deploy'

import { EPOCH_LENGTH, genUserState } from './utils'
import { genEpochKey } from '@unirep/utils'
import { Circuit } from '@unirep/circuits'

const checkSignals = (signals, proof) => {
    expect(signals.epochKey.toString()).equal(proof.epochKey.toString())
    expect(signals.stateTreeRoot.toString()).equal(
        proof.stateTreeRoot.toString()
    )
    expect(signals.nonce.toString()).equal(proof.nonce.toString())
    expect(signals.epoch.toString()).equal(proof.epoch.toString())
    expect(signals.attesterId.toString()).equal(proof.attesterId.toString())
    expect(signals.revealNonce).equal(Boolean(proof.revealNonce))
    expect(signals.chainId.toString()).equal(proof.chainId.toString())
    expect(signals.minRep.toString()).equal(proof.minRep.toString())
    expect(signals.maxRep.toString()).equal(proof.maxRep.toString())
    expect(signals.proveMinRep).equal(Boolean(proof.proveMinRep))
    expect(signals.proveMaxRep).equal(Boolean(proof.proveMaxRep))
    expect(signals.proveZeroRep).equal(Boolean(proof.proveZeroRep))
    expect(signals.proveGraffiti).equal(Boolean(proof.proveGraffiti))
    expect(signals.graffiti.toString()).equal(proof.graffiti.toString())
    expect(signals.data.toString()).equal(proof.data.toString())
}

describe('Reputation proof', function () {
    this.timeout(0)

    let unirepContract
    let repVerifierHelper
    let chainId

    before(async () => {
        const accounts = await ethers.getSigners()
        unirepContract = await deployUnirep(accounts[0])
        repVerifierHelper = await deployVerifierHelper(
            unirepContract.address,
            accounts[0],
            Circuit.reputation
        )
        const network = await accounts[0].provider.getNetwork()
        chainId = network.chainId
    })

    {
        let snapshot
        beforeEach(async () => {
            snapshot = await ethers.provider.send('evm_snapshot', [])
            const accounts = await ethers.getSigners()
            const attester = accounts[1]
            await unirepContract
                .connect(attester)
                .attesterSignUp(EPOCH_LENGTH)
                .then((t) => t.wait())
        })

        afterEach(() => ethers.provider.send('evm_revert', [snapshot]))
    }

    it('should generate a zero reputation proof', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()
        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()
        const proveZeroRep = true
        const proof = await userState.genProveReputationProof({
            proveZeroRep,
        })

        const valid = await proof.verify()
        expect(valid).to.be.true

        const signals = await repVerifierHelper.verifyAndCheck(
            proof.publicSignals,
            proof.proof
        )
        checkSignals(signals, proof)
        userState.stop()
    })

    it('should reveal epoch key nonce', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()
        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()
        const epkNonce = 1
        const revealNonce = true
        const proof = await userState.genProveReputationProof({
            epkNonce,
            revealNonce,
        })

        const valid = await proof.verify()
        expect(valid).to.be.true
        expect(proof.nonce).to.equal(epkNonce)

        const signals = await repVerifierHelper.verifyAndCheck(
            proof.publicSignals,
            proof.proof
        )
        checkSignals(signals, proof)
        userState.stop()
    })

    it('should not reveal epoch key nonce', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()
        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()
        const epkNonce = 1
        const revealNonce = false
        const proof = await userState.genProveReputationProof({
            epkNonce,
            revealNonce,
        })

        const valid = await proof.verify()
        expect(valid).to.be.true
        expect(proof.nonce).to.equal('0')

        const signals = await repVerifierHelper.verifyAndCheck(
            proof.publicSignals,
            proof.proof
        )
        checkSignals(signals, proof)
        userState.stop()
    })

    it('should prove minRep', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()
        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()

        const minRep = 1
        const epochKey = genEpochKey(
            id.secret,
            attester.address,
            epoch,
            0,
            chainId
        )
        const field = userState.sync.settings.sumFieldCount

        await unirepContract
            .connect(attester)
            .attest(epochKey, epoch, field, minRep)
            .then((t) => t.wait())

        // setting posRep to 5
        await unirepContract
            .connect(attester)
            .attest(epochKey, epoch, 0, 5)
            .then((t) => t.wait())

        // setting negRep to 3
        await unirepContract
            .connect(attester)
            .attest(epochKey, epoch, 1, 3)
            .then((t) => t.wait())

        await ethers.provider.send('evm_increaseTime', [EPOCH_LENGTH])
        await ethers.provider.send('evm_mine', [])

        const toEpoch = await unirepContract.attesterCurrentEpoch(
            attester.address
        )
        {
            await userState.waitForSync()
            const { publicSignals, proof } =
                await userState.genUserStateTransitionProof({
                    toEpoch,
                })
            await unirepContract
                .connect(accounts[4])
                .userStateTransition(publicSignals, proof)
                .then((t) => t.wait())
        }

        await userState.waitForSync()
        const proof = await userState.genProveReputationProof({
            minRep,
        })

        const valid = await proof.verify()
        expect(valid).to.be.true
        expect(proof.minRep).to.equal(minRep.toString())
        expect(proof.proveMinRep).to.equal('1')

        const signals = await repVerifierHelper.verifyAndCheck(
            proof.publicSignals,
            proof.proof
        )
        checkSignals(signals, proof)
        userState.stop()
    })

    it('should prove maxRep', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()
        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()

        const maxRep = 2
        const epochKey = genEpochKey(
            id.secret,
            attester.address,
            epoch,
            0,
            chainId
        )
        const field = userState.sync.settings.sumFieldCount

        await unirepContract
            .connect(attester)
            .attest(epochKey, epoch, field, maxRep)
            .then((t) => t.wait())

        // setting posRep to 5
        await unirepContract
            .connect(attester)
            .attest(epochKey, epoch, 0, 5)
            .then((t) => t.wait())

        // setting negRep to 10
        await unirepContract
            .connect(attester)
            .attest(epochKey, epoch, 1, 10)
            .then((t) => t.wait())

        await ethers.provider.send('evm_increaseTime', [EPOCH_LENGTH])
        await ethers.provider.send('evm_mine', [])

        const toEpoch = await unirepContract.attesterCurrentEpoch(
            attester.address
        )
        {
            await userState.waitForSync()
            const { publicSignals, proof } =
                await userState.genUserStateTransitionProof({
                    toEpoch,
                })
            await unirepContract
                .connect(accounts[4])
                .userStateTransition(publicSignals, proof)
                .then((t) => t.wait())
        }

        await userState.waitForSync()
        const proof = await userState.genProveReputationProof({
            maxRep,
        })

        const valid = await proof.verify()
        expect(valid).to.be.true
        expect(proof.maxRep).to.equal(maxRep.toString())
        expect(proof.proveMaxRep).to.equal('1')

        const signals = await repVerifierHelper.verifyAndCheck(
            proof.publicSignals,
            proof.proof
        )
        checkSignals(signals, proof)
        userState.stop()
    })

    it('should prove graffiti', async () => {
        const accounts = await ethers.getSigners()
        const attester = accounts[1]
        const attesterId = BigInt(attester.address)
        const id = new Identity()
        const userState = await genUserState(
            ethers.provider,
            unirepContract.address,
            id,
            attesterId
        )
        const epoch = await userState.sync.loadCurrentEpoch()
        {
            const { publicSignals, proof } = await userState.genUserSignUpProof(
                { epoch }
            )
            await unirepContract
                .connect(attester)
                .userSignUp(publicSignals, proof)
                .then((t) => t.wait())
        }
        await userState.waitForSync()

        const graffiti = BigInt(12345)
        const epochKey = genEpochKey(
            id.secret,
            attester.address,
            epoch,
            0,
            chainId
        )
        const field = userState.sync.settings.sumFieldCount
        await unirepContract
            .connect(attester)
            .attest(epochKey, epoch, field, graffiti)
            .then((t) => t.wait())

        await ethers.provider.send('evm_increaseTime', [EPOCH_LENGTH])
        await ethers.provider.send('evm_mine', [])

        const toEpoch = await unirepContract.attesterCurrentEpoch(
            attester.address
        )
        {
            await userState.waitForSync()
            const { publicSignals, proof } =
                await userState.genUserStateTransitionProof({
                    toEpoch,
                })
            await unirepContract
                .connect(accounts[4])
                .userStateTransition(publicSignals, proof)
                .then((t) => t.wait())
        }

        await userState.waitForSync()
        const proof = await userState.genProveReputationProof({
            graffiti,
        })

        const valid = await proof.verify()
        expect(valid).to.be.true
        expect(proof.graffiti).to.equal(graffiti.toString())
        expect(proof.proveGraffiti).to.equal('1')

        const signals = await repVerifierHelper.verifyAndCheck(
            proof.publicSignals,
            proof.proof
        )
        checkSignals(signals, proof)
        userState.stop()
    })
})
