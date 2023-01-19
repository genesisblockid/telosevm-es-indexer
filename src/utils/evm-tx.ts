import {
    BN,
    bnToHex,
    bnToUnpaddedBuffer,
    ecrecover,
    MAX_INTEGER,
    rlp,
    rlphash,
    toBuffer,
    unpadBuffer,
} from 'ethereumjs-util'

import {Capability, JsonTx, N_DIV_2, TxData, TxOptions, TxValuesArray} from '@ethereumjs/tx'
import {BaseTransaction} from '@ethereumjs/tx/dist/baseTransaction.js'
import {checkMaxInitCodeSize} from '@ethereumjs/tx/dist/util.js'
import {numToHex} from './evm.js'

/**
 * An Ethereum non-typed (legacy) transaction
 */
export class TEVMTransaction extends BaseTransaction<TEVMTransaction> {
    public readonly gasPrice: BN

    // public readonly common: Common

    /**
     * Instantiate a transaction from a data dictionary.
     *
     * Format: { nonce, gasPrice, gasLimit, to, value, data, v, r, s }
     *
     * Notes:
     * - All parameters are optional and have some basic default values
     */
    public static fromTxData(txData: TxData, opts: TxOptions = {}) {
        return new TEVMTransaction(txData, opts)
    }

    /**
     * Instantiate a transaction from the serialized tx.
     *
     * Format: `rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])`
     */
    public static fromSerializedTx(serialized: Buffer, opts: TxOptions = {}) {
        let values: any = rlp.decode(serialized, true)

        if (!Array.isArray(values) && values.hasOwnProperty('data'))
            values = values.data;

        if (!Array.isArray(values)) {
            throw new Error('Invalid serialized tx input. Must be array')
        }

        return this.fromValuesArray(values, opts)
    }

    /**
     * Instantiate a transaction from the serialized tx.
     * (alias of {@link Transaction.fromSerializedTx})
     *
     * @deprecated this constructor alias is deprecated and will be removed
     * in favor of the {@link Transaction.fromSerializedTx} constructor
     */
    public static fromRlpSerializedTx(serialized: Buffer, opts: TxOptions = {}) {
        return TEVMTransaction.fromSerializedTx(serialized, opts)
    }

    /**
     * Create a transaction from a values array.
     *
     * Format: `[nonce, gasPrice, gasLimit, to, value, data, v, r, s]`
     */
    public static fromValuesArray(values: TxValuesArray, opts: TxOptions = {}) {
        // If length is not 6, it has length 9. If v/r/s are empty Buffers, it is still an unsigned transaction
        // This happens if you get the RLP data from `raw()`
        if (values.length !== 6 && values.length !== 9) {
            throw new Error(
                'Invalid transaction. Only expecting 6 values (for unsigned tx) or 9 values (for signed tx).'
            )
        }

        const [nonce, gasPrice, gasLimit, to, value, data, v, r, s] = values

        // validateNoLeadingZeroes({ nonce, gasPrice, gasLimit, value, v, r, s })

        return new TEVMTransaction(
            {
                nonce,
                gasPrice,
                gasLimit,
                to,
                value,
                data,
                v,
                r,
                s,
            },
            opts
        )
    }

    /**
     * This constructor takes the values, validates them, assigns them and freezes the object.
     *
     * It is not recommended to use this constructor directly. Instead use
     * the static factory methods to assist in creating a Transaction object from
     * varying data types.
     */
    public constructor(txData: TxData, opts: TxOptions = {}) {
        super(txData, opts);

        this.gasPrice = new BN(toBuffer(txData.gasPrice === '' ? '0x' : txData.gasPrice))

        if (this.gasPrice.mul(this.gasLimit).gt(MAX_INTEGER)) {
            const msg = this._errorMsg('gas limit * gasPrice cannot exceed MAX_INTEGER (2^256-1)')
            throw new Error(msg)
        }
        this._validateCannotExceedMaxInteger({gasPrice: this.gasPrice})

        // if (this.common.gteHardfork('spuriousDragon')) {
        if (!this.isSigned()) {
            this.activeCapabilities.push(Capability.EIP155ReplayProtection)
        } else {
            // EIP155 spec:
            // If block.number >= 2,675,000 and v = CHAIN_ID * 2 + 35 or v = CHAIN_ID * 2 + 36
            // then when computing the hash of a transaction for purposes of signing or recovering
            // instead of hashing only the first six elements (i.e. nonce, gasprice, startgas, to, value, data)
            // hash nine elements, with v replaced by CHAIN_ID, r = 0 and s = 0.
            const v = this.v!
            const chainIdDoubled = this.txOptions.common.chainIdBN().muln(2)

            // v and chain ID meet EIP-155 conditions
            if (v.eq(chainIdDoubled.addn(35)) || v.eq(chainIdDoubled.addn(36))) {
                this.activeCapabilities.push(Capability.EIP155ReplayProtection)
            }
        }
        // }

        if (this.txOptions.common.isActivatedEIP(3860)) {
            checkMaxInitCodeSize(this.txOptions.common, this.data.length)
        }

        const freeze = opts?.freeze ?? true
        if (freeze) {
            Object.freeze(this)
        }
    }

    /**
     * Returns a Buffer Array of the raw Buffers of the legacy transaction, in order.
     *
     * Format: `[nonce, gasPrice, gasLimit, to, value, data, v, r, s]`
     *
     * For legacy txs this is also the correct format to add transactions
     * to a block with {@link Block.fromValuesArray} (use the `serialize()` method
     * for typed txs).
     *
     * For an unsigned tx this method returns the empty Buffer values
     * for the signature parameters `v`, `r` and `s`. For an EIP-155 compliant
     * representation have a look at {@link Transaction.getMessageToSign}.
     */
    raw(): TxValuesArray {
        return [
            bnToUnpaddedBuffer(this.nonce),
            bnToUnpaddedBuffer(this.gasPrice),
            bnToUnpaddedBuffer(this.gasLimit),
            this.to !== undefined ? this.to.buf : Buffer.from([]),
            bnToUnpaddedBuffer(this.value),
            this.data,
            this.v !== undefined ? bnToUnpaddedBuffer(this.v) : Buffer.from([]),
            this.r !== undefined ? bnToUnpaddedBuffer(this.r) : Buffer.from([]),
            this.s !== undefined ? bnToUnpaddedBuffer(this.s) : Buffer.from([]),
        ]
    }

    public isSigned(): boolean {
        const {v, r, s} = this
        if ((v === undefined || r === undefined || s === undefined)) {
            return false;
        } else if ((v == this.txOptions.common.chainIdBN()) && (bnToHex(r) === numToHex(0)) && (bnToHex(s) === numToHex(0))) {
            return false;
        } else if ((bnToHex(v) === numToHex(0)) && (bnToHex(r) === numToHex(0)) && (bnToHex(s) === numToHex(0))) {
            return false;
        } else {
            return true;
        }
    }

    /**
     * Returns the serialized encoding of the legacy transaction.
     *
     * Format: `rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s])`
     *
     * For an unsigned tx this method uses the empty Buffer values for the
     * signature parameters `v`, `r` and `s` for encoding. For an EIP-155 compliant
     * representation for external signing use {@link Transaction.getMessageToSign}.
     */
    serialize(): Buffer {
        return rlp.encode(this.raw())
    }

    private _getMessageToSign() {
        const values = [
            bnToUnpaddedBuffer(this.nonce),
            bnToUnpaddedBuffer(this.gasPrice),
            bnToUnpaddedBuffer(this.gasLimit),
            this.to !== undefined ? this.to.buf : Buffer.from([]),
            bnToUnpaddedBuffer(this.value),
            this.data,
        ]

        if (this.supports(Capability.EIP155ReplayProtection)) {
            values.push(toBuffer(this.txOptions.common.chainIdBN()))
            values.push(unpadBuffer(toBuffer(0)))
            values.push(unpadBuffer(toBuffer(0)))
        }

        return values
    }

    /**
     * Returns the unsigned tx (hashed or raw), which can be used
     * to sign the transaction (e.g. for sending to a hardware wallet).
     *
     * Note: the raw message message format for the legacy tx is not RLP encoded
     * and you might need to do yourself with:
     *
     * ```javascript
     * import { rlp } from 'ethereumjs-util'
     * const message = tx.getMessageToSign(false)
     * const serializedMessage = rlp.encode(message) // use this for the HW wallet input
     * ```
     *
     * @param hashMessage - Return hashed message if set to true (default: true)
     */
    getMessageToSign(hashMessage: false): Buffer[]
    getMessageToSign(hashMessage?: true): Buffer
    getMessageToSign(hashMessage = true) {
        const message = this._getMessageToSign()
        if (hashMessage) {
            return rlphash(message)
        } else {
            return message
        }
    }

    /**
     * The amount of gas paid for the data in this tx
     */
    getDataFee(): BN {
        if (this.cache.dataFee && this.cache.dataFee.hardfork === this.txOptions.common.hardfork()) {
            return this.cache.dataFee.value
        }

        if (Object.isFrozen(this)) {
            this.cache.dataFee = {
                value: super.getDataFee(),
                hardfork: this.txOptions.common.hardfork(),
            }
        }

        return super.getDataFee()
    }

    /**
     * The up front amount that an account must have for this transaction to be valid
     */
    getUpfrontCost(): BN {
        return this.gasLimit.mul(this.gasPrice).add(this.value)
    }

    /**
     * Computes a sha3-256 hash of the serialized tx.
     *
     * This method can only be used for signed txs (it throws otherwise).
     * Use {@link Transaction.getMessageToSign} to get a tx hash for the purpose of signing.
     */
    hash(): Buffer {
        // In contrast to the tx type transaction implementations the `hash()` function
        // for the legacy tx does not throw if the tx is not signed.
        // This has been considered for inclusion but lead to unexpected backwards
        // compatibility problems (no concrete reference found, needs validation).
        //
        // For context see also https://github.com/ethereumjs/ethereumjs-monorepo/pull/1445,
        // September, 2021 as well as work done before.
        //
        // This should be updated along the next major version release by adding:
        //
        //if (!this.isSigned()) {
        //  const msg = this._errorMsg('Cannot call hash method if transaction is not signed')
        //  throw new Error(msg)
        //}

        if (Object.isFrozen(this)) {
            if (!this.cache.hash) {
                this.cache.hash = rlphash(this.raw())
            }
            return this.cache.hash
        }

        return rlphash(this.raw())
    }

    /**
     * Computes a sha3-256 hash which can be used to verify the signature
     */
    getMessageToVerifySignature() {
        if (!this.isSigned()) {
            const msg = this._errorMsg('This transaction is not signed')
            throw new Error(msg)
        }
        const message = this._getMessageToSign()
        return rlphash(message)
    }

    /**
     * Returns the public key of the sender
     */
    getSenderPublicKey(): Buffer {
        const msgHash = this.getMessageToVerifySignature()

        // EIP-2: All transaction signatures whose s-value is greater than secp256k1n/2 are considered invalid.
        // Reasoning: https://ethereum.stackexchange.com/a/55728
        if (this.txOptions.common.gteHardfork('homestead') && this.s?.gt(N_DIV_2)) {
            const msg = this._errorMsg(
                'Invalid Signature: s-values greater than secp256k1n/2 are considered invalid'
            )
            throw new Error(msg)
        }

        const {v, r, s} = this
        try {
            return ecrecover(
                msgHash,
                v!,
                bnToUnpaddedBuffer(r!),
                bnToUnpaddedBuffer(s!),
                this.supports(Capability.EIP155ReplayProtection) ? this.txOptions.common.chainIdBN() : undefined
            )
        } catch (e: any) {
            const msg = this._errorMsg('Invalid Signature')
            throw new Error(msg)
        }
    }

    /**
     * Process the v, r, s values from the `sign` method of the base transaction.
     */
    protected _processSignature(v: number, r: Buffer, s: Buffer) {
        const vBN = new BN(v)
        if (this.supports(Capability.EIP155ReplayProtection)) {
            vBN.iadd(this.txOptions.common.chainIdBN().muln(2).addn(8))
        }

        const opts = {
            common: this.txOptions.common,
        }

        return TEVMTransaction.fromTxData(
            {
                nonce: this.nonce,
                gasPrice: this.gasPrice,
                gasLimit: this.gasLimit,
                to: this.to,
                value: this.value,
                data: this.data,
                v: vBN,
                r: new BN(r),
                s: new BN(s),
            },
            opts
        )
    }

    /**
     * Returns an object with the JSON representation of the transaction.
     */
    toJSON(): JsonTx {
        return {
            nonce: bnToHex(this.nonce),
            gasPrice: bnToHex(this.gasPrice),
            gasLimit: bnToHex(this.gasLimit),
            to: this.to !== undefined ? this.to.toString() : undefined,
            value: bnToHex(this.value),
            data: '0x' + this.data.toString('hex'),
            v: this.v !== undefined ? bnToHex(this.v) : undefined,
            r: this.r !== undefined ? bnToHex(this.r) : undefined,
            s: this.s !== undefined ? bnToHex(this.s) : undefined,
        }
    }

    /**
     * Return a compact error string representation of the object
     */
    public errorStr() {
        let errorStr = this._getSharedErrorPostfix()
        errorStr += ` gasPrice=${this.gasPrice}`
        return errorStr
    }

    /**
     * Internal helper function to create an annotated error message
     *
     * @param msg Base error message
     * @hidden
     */
    protected _errorMsg(msg: string) {
        return `${msg} (${this.errorStr()})`
    }
}
