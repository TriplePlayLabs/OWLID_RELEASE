// ESM wrapper for native-sdk
// This provides static ESM exports for bundlers like rollup/vite
import nativeBinding from './index.js'

export const Credential = nativeBinding.Credential
export const Document = nativeBinding.Document
export const KeyPair = nativeBinding.KeyPair
export const PreparedToken = nativeBinding.PreparedToken
export const PublicKey = nativeBinding.PublicKey
export const Signature = nativeBinding.Signature
export const Token = nativeBinding.Token
export const blake3 = nativeBinding.blake3
export const sha256 = nativeBinding.sha256
export const provingKeysRequired = nativeBinding.provingKeysRequired
export const setProvingKeyBytes = nativeBinding.setProvingKeyBytes

export default nativeBinding
