import { Unirep, Unirep__factory as UnirepFactory } from '../typechain'
import { ethers } from 'ethers'

/**
 * Get Unirep smart contract from a given address
 * @param address The address if the Unirep contract
 * @param signerOrProvider The signer or provider that connect to the Unirep smart contract
 * @returns The Unirep smart contract
 */
export const getUnirepContract = (
    address: string,
    signerOrProvider: ethers.Signer | ethers.providers.Provider
): Unirep => {
    return UnirepFactory.connect(address, signerOrProvider)
}
export { Unirep, UnirepFactory }

/**
 * Generate attester sign up signature
 * @param unirepAddress The address of UniRep smart contract
 * @param attesterAddress The address of the attester
 * @param epochLength Epoch length of the attester
 * @param chainId The current UniRep contract the attester wants to signup
 * @returns An sign up signature for the attester
 */
export const genSignature = async (
    unirepAddress: string,
    attester: ethers.Signer | ethers.Wallet,
    epochLength: number,
    chainId: bigint | number
): Promise<string> => {
    const attesterAddress = await attester.getAddress()
    const message = ethers.utils.solidityKeccak256(
        ['address', 'address', 'uint256', 'uint256'],
        [unirepAddress, attesterAddress, epochLength, chainId]
    )
    return attester.signMessage(ethers.utils.arrayify(message))
}
