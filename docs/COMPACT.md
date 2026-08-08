# Compact language reference

> Reference notes for Midnight's Compact smart contract language. Compiled from official docs, GitHub repos, OpenZeppelin contracts, and community resources.
>
> **Authoritative spec**: the definitive language reference is the upstream
> [Compact language reference](https://docs.midnight.network/compact/reference/compact-reference)
> (source: `doc/compact-reference.mdx` in the compact repo). This document is
> OwlID's _integration playbook_ — for syntax/semantics, defer to upstream.
> The high-value, OwlID-specific material is the SDK wiring (§14), infra (§15),
> testing (§21), and deployment (§22) sections.
>
> **Toolchain target**: this repo pins Compact `0.31.0` (`compact update 0.31.0`).

---

## 1. Overview

**Compact** (recently contributed to Linux Foundation as **Minokawa**) is Midnight's domain-specific smart contract language. It has TypeScript-like syntax and compiles to zero-knowledge circuits (zk-SNARKs using BLS12-381/Halo2).

Key concepts:

- **Ledger**: Public on-chain state
- **Circuits**: Entry points (like Solidity functions) that run off-chain, produce ZK proofs
- **Witnesses**: Functions providing private data from the user's machine
- **`disclose`**: Explicit operator to move private data to public ledger
- All computation not in the ledger is **confidential by default**

### Architecture

```
User's DApp (TypeScript) → Compact Circuit (local execution) → ZK Proof → On-chain verification
                          ↑ Witness functions (private data)
```

### Proving System

- **BLS12-381** elliptic curves with **Halo2** recursive zk-SNARKs
- Proofs: ~128 bytes, verification: ~6ms on-chain
- Built in collaboration with Galois, Inc.

---

## 2. Language Basics

### File Structure

```compact
pragma language_version >= 0.21.0;

import CompactStandardLibrary;
// or selective imports:
import { ZswapCoinPublicKey, ContractAddress, Either, Maybe } from CompactStandardLibrary;

// Re-export types for TypeScript consumers
export { ZswapCoinPublicKey, ContractAddress, Either, Maybe };

// Enum declarations
export enum State { VACANT, OCCUPIED }

// Ledger declarations (public on-chain state)
export ledger owner: Bytes<32>;
export ledger value: Uint<64>;
export ledger state: State;
export ledger round: Counter;

// Constructor (runs at deployment)
constructor(initialOwner: Either<ZswapCoinPublicKey, ContractAddress>) {
  // initialization
}

// Witness declarations (implemented in TypeScript)
witness secretKey(): Bytes<32>;

// Circuit declarations (entry points)
export circuit get(): Uint<64> {
  return value;
}
```

### Reserved Words

`pragma`, `import`, `from`, `export`, `ledger`, `circuit`, `witness`, `constructor`,
`enum`, `struct`, `if`, `else`, `for`, `const`, `return`, `assert`, `disclose`,
`as`, `pad`, `default`, `true`, `false`, `left`, `right`, `some`, `none`

---

## 3. Type System

### Primitive Types

| Type               | Description                             | Example                 |
| ------------------ | --------------------------------------- | ----------------------- |
| `Field`            | ZK field element (native to circuit)    | `_val: Field`           |
| `Bytes<N>`         | Fixed-length byte array                 | `Bytes<32>`             |
| `Uint<N>`          | Unsigned integer (N bits)               | `Uint<64>`, `Uint<128>` |
| `Boolean`          | True/false                              | `Boolean`               |
| `Opaque<"string">` | Opaque type bridging JS strings (UTF-8) | `Opaque<"string">`      |

### Compound Types

| Type           | Description              | Example                                       |
| -------------- | ------------------------ | --------------------------------------------- |
| `Vector<N, T>` | Fixed-size array         | `Vector<3, Bytes<32>>`                        |
| `Maybe<T>`     | Optional value           | `Maybe<Opaque<"string">>`                     |
| `Either<A, B>` | Sum type (left or right) | `Either<ZswapCoinPublicKey, ContractAddress>` |

### Standard Library Types

| Type                 | Description                              |
| -------------------- | ---------------------------------------- |
| `ZswapCoinPublicKey` | User's public key for the Zswap protocol |
| `ContractAddress`    | On-chain contract address                |
| `CoinInfo`           | Token/coin information                   |
| `NativePoint`        | Elliptic curve point (was `CurvePoint`)  |

### Type Casting with `as`

```compact
// Field to Bytes
round as Field as Bytes<32>

// Uint casting
value as Uint<128>

// Field to Bytes: least-significant byte first, padded with trailing zeros
// Runtime error if value doesn't fit in the target length
```

### `pad` Function

```compact
// pad(N, string) - pads string to N bytes
pad(32, "midnight:owlid:pk:")
// Used for domain separation in hashing
```

### `default<T>` Expression

```compact
// Returns the default/zero value for a type
default<Map<Either<ZswapCoinPublicKey, ContractAddress>, Uint<128>>>
```

---

## 4. Ledger (On-Chain State)

The ledger stores **public**, on-chain state. Every field is declared with `export ledger`:

```compact
export ledger authority: Bytes<32>;
export ledger value: Uint<64>;
export ledger state: State;
export ledger round: Counter;
export ledger message: Maybe<Opaque<"string">>;
export ledger owner: Either<ZswapCoinPublicKey, ContractAddress>;
```

**Rules:**

- Ledger fields are visible to all network participants
- A field of type `T` implicitly has type `Cell<T>` (supports read/write/reset)
- Initialized by the constructor at deployment time
- `export` makes the field accessible to DApp TypeScript code

---

## 5. Ledger ADTs

### Counter

```compact
export ledger round: Counter;

// Operations:
round.increment(1);       // increment by amount (Uint<16>)
round.decrement(1);       // decrement (error if below 0)
round.read();             // get current value
round.lessThan(threshold); // compare
// Auto-initialized to 0
```

### Map<K, V>

```compact
export ledger _balances: Map<Either<ZswapCoinPublicKey, ContractAddress>, Uint<128>>;
// Or nested:
export ledger _balances: Map<Uint<128>, Map<Either<ZswapCoinPublicKey, ContractAddress>, Uint<128>>>;

// Operations:
_balances.member(key);         // check if key exists → Boolean
_balances.lookup(key);         // get value (or nested map)
_balances.insert(key, value);  // set key-value pair
_balances.remove(key);         // delete key
_balances.size();              // number of entries
_balances.isEmpty();           // check if empty
_balances.resetToDefault();    // clear all entries
```

### Set<T>

```compact
export ledger _revokedSet: Set<Bytes<32>>;

// Operations:
_revokedSet.member(value);      // check membership → Boolean
_revokedSet.insert(value);      // add element
_revokedSet.remove(value);      // remove element
_revokedSet.size();             // count
_revokedSet.isEmpty();          // check if empty
_revokedSet.resetToDefault();   // clear
```

### MerkleTree<N, T>

```compact
export ledger _commitments: MerkleTree<32, Bytes<32>>;

// Operations:
_commitments.insert(leaf);              // insert at first free index
_commitments.insertAtIndex(leaf, idx);  // insert at specific index
_commitments.root();                    // get Merkle root → Bytes<32>
_commitments.freeIndex();               // next free index
_commitments.findPath(leaf);            // get proof path (O(n), avoid for large trees)
_commitments.insertHash(hash);          // insert pre-hashed leaf
_commitments.insertHashIndex(hash, idx); // insert pre-hashed at index
_commitments.memberRoot(root);          // check if root was ever a valid root
```

### HistoricMerkleTree<N, T>

Same as MerkleTree but retains history of past roots. `memberRoot(root)` checks against all historical roots.

### Cell<T>

```compact
// Implicit for all ledger fields of non-ADT types
export ledger _uri: Opaque<"string">;

// Operations:
_uri.read();            // get value (implicit, just use _uri)
_uri = disclose(val);   // write value
_uri.resetToDefault();  // reset to zero/empty
_uri.writeCoin(info);   // write coin info
```

### List<T>

```compact
export ledger _queue: List<Bytes<32>>;

// Operations:
_queue.pushFront(value);  // prepend
_queue.popFront();        // remove first → value
_queue.head();            // peek first
_queue.length();          // count
_queue.isEmpty();         // check if empty
_queue.resetToDefault();  // clear
```

---

## 6. Circuits (Entry Points)

Circuits are the callable functions of a Compact contract. They compile to ZK circuits.

```compact
// Public entry point (callable from DApp)
export circuit get(): Uint<64> {
  assert(state == State.SET, "Attempted to get uninitialized value");
  return value;
}

// Internal circuit (not exported, used by other circuits)
circuit _update(from: Either<ZswapCoinPublicKey, ContractAddress>,
                to: Either<ZswapCoinPublicKey, ContractAddress>,
                amount: Uint<128>): [] {
  // internal logic
}

// Return type [] means void/unit
export circuit increment(): [] {
  round.increment(1);
}
```

**Key rules:**

- `export circuit` = callable from TypeScript DApp code
- `circuit` (no export) = internal, callable only from other circuits
- Return type `[]` = void
- Circuits have **fixed computational bounds** determined at compile time
- Each circuit generates a separate ZK proving/verifying key pair

### Getting the Caller's Public Key

```compact
// ownPublicKey() returns ZswapCoinPublicKey of the transaction sender
const caller = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
assert(caller == owner, "Not authorized");
```

---

## 7. Witnesses (Private Data)

Witnesses provide off-chain private data to circuits. Declared in Compact, implemented in TypeScript.

### Declaration (Compact)

```compact
witness secretKey(): Bytes<32>;
witness localData(arg: Field): Field;
witness getCredential(rootHash: Bytes<32>): Bytes<32>;
```

### Implementation (TypeScript DApp)

```typescript
// When deploying/joining a contract, provide witness implementations:
const witnesses = {
  secretKey: ({ privateState }) => {
    return privateState.secretKey // Returns Bytes<32>
  },
  localData: ({ privateState }, arg) => {
    return someComputation(arg)
  },
}
```

**Key rules:**

- Witness return values are **private by default**
- Must use `disclose()` to make them public
- The DApp is responsible for implementing all witnesses
- Witnesses receive a `WitnessContext` with public ledger state, private state, and contract address
- Witnesses can accept arguments from the circuit

---

## 8. Privacy Model & `disclose`

### Rule

> All data that is not a ledger field and is not an argument or return value of a ledger operation is kept **confidential**.

### `disclose` Operator

`disclose()` is a **compile-time annotation** that tells the compiler you intend to expose a private value to the public ledger. It has **no runtime effect**.

```compact
export circuit post(newMessage: Opaque<"string">): [] {
  const sk = secretKey();  // private (from witness)
  const pk = publicKey(sk, round as Bytes<32>);  // private (derived from private data)

  // disclose() explicitly marks these as intentionally public
  owner = disclose(pk);
  message = disclose(some<Opaque<"string">>(newMessage));
  state = State.OCCUPIED;
}
```

Without `disclose()`, the compiler will error if you try to assign private-derived data to a ledger field.

---

## 9. Control Flow

### Conditionals

```compact
if (condition) {
  // then branch
} else {
  // else branch
}
```

### For Loops

Compact has **no C-style `for`**. Iteration is either over a numeric range or
over a vector/array. Bounds must be known at compile time (the circuit is
unrolled); since 0.31 the range bounds may be generic parameters.

```compact
// Range iteration: start (inclusive) .. end (exclusive)
for (const i of 0..10) {
  // body — i takes 0, 1, ..., 9
}

// Iterate over a vector or array literal
for (const x of myVector) {
  // body
}
```

### Assert

```compact
assert(condition, "Error message");
// Aborts execution if condition is false
```

### Return

```compact
return value;    // explicit return
return;          // void return (type [])
// Every path through a circuit body must end with return
```

---

## 10. Standard Library

### Hashing

```compact
// For ledger storage (deterministic, cross-DApp consistent)
circuit persistentHash<T>(value: T): Bytes<32>;
circuit persistentCommit<T>(value: T, rand: Bytes<32>): Bytes<32>;

// For temporary values (not stored)
circuit transientHash<T>(value: T): Field;
circuit transientCommit<T>(value: T, rand: Field): Field;

// keccak256 — same signature as persistentHash (added post-0.31.0).
// Requires the experimental --feature-zkir-v3 flag in a circuit that
// touches public ledger state; compiler error under the ZKIR v2 backend.
circuit keccak256<T>(value: T): Bytes<32>;
```

### Maybe<T> Operations

```compact
some<Opaque<"string">>(value)    // wrap value
none<Opaque<"string">>()         // empty
maybe.value                       // unwrap (error if none)
```

### Either<A, B> Operations

```compact
left<ZswapCoinPublicKey, ContractAddress>(key)    // wrap as left
right<ZswapCoinPublicKey, ContractAddress>(addr)  // wrap as right
```

### Identity Functions

```compact
ownPublicKey()  // ZswapCoinPublicKey of the transaction sender
```

### Burn Address

```compact
// Used for minting/burning tokens (zero address equivalent)
shieldedBurnAddress()  // returns Either<ZswapCoinPublicKey, ContractAddress>
```

---

## 11. Module System & Imports

### Standard Import

```compact
import CompactStandardLibrary;
```

### Selective Import

```compact
import { ZswapCoinPublicKey, ContractAddress, Either, Maybe } from CompactStandardLibrary;
```

### Import with Prefix (for composition)

```compact
import "../../Ownable" prefix Ownable_;
import "../../FungibleToken" prefix FungibleToken_;

// Usage: Ownable_initialize(), FungibleToken_transfer()
```

### Re-export

```compact
export { ZswapCoinPublicKey, ContractAddress, Either, Maybe };
```

---

## 12. Constructors

Run once at deployment time to initialize ledger state.

```compact
constructor(initialOwner: Either<ZswapCoinPublicKey, ContractAddress>, isInit: Boolean) {
  if (disclose(isInit)) {
    // Initialize ledger fields
    owner = disclose(initialOwner);
    state = State.VACANT;
    message = none<Opaque<"string">>();
    sequence.increment(1);
  }
}
```

**Rules:**

- Only one constructor per contract
- Called automatically during deployment
- Use `disclose()` for constructor arguments that go to ledger
- Can call internal initialization circuits

---

## 13. Compilation & Tooling

### Install Compact Compiler

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
source $HOME/.local/bin/env
compact update 0.31.0
```

### Compile a Contract

```bash
# In the contract directory:
compact compile src/my_contract.compact --output src/managed/

# Or via npm script:
npm run compact
```

### Skip ZK Generation (faster, for development/testing)

```bash
compact compile --skip-zk src/my_contract.compact src/managed/my_contract
```

> **NOTE**: `--skip-zk` only generates `.zkir` text files. You CANNOT deploy contracts
> compiled with `--skip-zk` because the `keys/*.verifier` files are missing.
> Use `--skip-zk` only for unit tests (with simulator).

> **NOTE**: The `+version` syntax (e.g., `+0.29.0`) does NOT work. Use `compact update 0.29.0` instead.

### Full Compile (required for deployment)

```bash
compact compile src/my_contract.compact src/managed/my_contract
```

This generates proving/verifier keys (requires SRS download, much slower).

### Generated Output (verified with compactc 0.29.0)

```
src/managed/
├── my_contract/
│   ├── compiler/
│   │   └── contract-info.json   # Contract metadata
│   ├── contract/
│   │   ├── index.js             # ESM module (generated TS)
│   │   ├── index.d.ts           # Type declarations
│   │   └── index.js.map         # Source map
│   ├── zkir/                    # ZK circuit intermediate representations
│   │   ├── circuitName.zkir     # Text ZKIR (always generated)
│   │   ├── circuitName.bzkir    # Binary ZKIR (only without --skip-zk)
│   │   └── ...
│   └── keys/                    # Only generated WITHOUT --skip-zk
│       ├── circuitName.prover   # Proving key
│       └── circuitName.verifier # Verifier key
```

### Common Compilation Errors & Fixes

**1. "potential witness-value disclosure must be declared"**
All ledger operations (member, lookup, insert, remove) require `disclose()` when
the argument is derived from circuit parameters or witnesses:

```compact
// WRONG:
issuerStatuses.lookup(keyHash)

// CORRECT:
issuerStatuses.lookup(disclose(keyHash))
```

**2. "cannot cast from type Bytes<N> to type Opaque<\"string\">"**
You cannot cast byte arrays to opaque strings. Use `remove()` instead of
inserting an empty string, or don't try to cast:

```compact
// WRONG:
credentialReasons.insert(disclose(rootHash), disclose(pad(1, "") as Opaque<"string">));

// CORRECT:
credentialReasons.remove(disclose(rootHash));
```

**3. "MerkleTree root is a runtime-only method"**
`MerkleTree.root()` cannot be called inside a circuit. Access it from TypeScript
via the ledger state at runtime:

```typescript
// In TypeScript (after joining contract):
const root = ledgerState.commitmentTree.root()
```

### Requirements

- **Node.js**: v22+
- **Compact Toolchain**: 0.31.0
- **Docker**: For proof server
- **TypeScript**: 5.8.3+

---

## 14. TypeScript SDK Wiring

### npm Packages (scope: `@midnight-ntwrk`)

#### DApp Packages (browser)

```json
{
  "dependencies": {
    "@midnight-ntwrk/compact-runtime": "^0.14.0",
    "@midnight-ntwrk/compact-js": "^2.4.0",
    "@midnight-ntwrk/midnight-js-types": "^3.1.0",
    "@midnight-ntwrk/midnight-js-contracts": "^3.1.0",
    "@midnight-ntwrk/midnight-js-fetch-zk-config-provider": "^3.1.0",
    "@midnight-ntwrk/midnight-js-http-client-proof-provider": "^3.1.0",
    "@midnight-ntwrk/midnight-js-indexer-public-data-provider": "^3.1.0",
    "@midnight-ntwrk/midnight-js-level-private-state-provider": "^3.1.0",
    "@midnight-ntwrk/midnight-js-network-id": "^3.1.0",
    "@midnight-ntwrk/dapp-connector-api": "^4.0.1"
  }
}
```

#### Server-Side / Headless Wallet Packages (v2.0.0)

```json
{
  "dependencies": {
    "@midnight-ntwrk/compact-js": "2.5.0",
    "@midnight-ntwrk/compact-runtime": "0.16.0",
    "@midnight-ntwrk/ledger-v8": "8.0.3",
    "@midnight-ntwrk/midnight-js-contracts": "4.0.4",
    "@midnight-ntwrk/midnight-js-http-client-proof-provider": "4.0.4",
    "@midnight-ntwrk/midnight-js-indexer-public-data-provider": "4.0.4",
    "@midnight-ntwrk/midnight-js-level-private-state-provider": "4.0.4",
    "@midnight-ntwrk/midnight-js-network-id": "4.0.4",
    "@midnight-ntwrk/midnight-js-node-zk-config-provider": "4.0.4",
    "@midnight-ntwrk/midnight-js-types": "4.0.4",
    "@midnight-ntwrk/wallet-sdk-abstractions": "2.0.0",
    "@midnight-ntwrk/wallet-sdk-address-format": "3.1.0",
    "@midnight-ntwrk/wallet-sdk-capabilities": "3.2.0",
    "@midnight-ntwrk/wallet-sdk-dust-wallet": "3.0.0",
    "@midnight-ntwrk/wallet-sdk-facade": "3.0.0",
    "@midnight-ntwrk/wallet-sdk-hd": "3.0.1",
    "@midnight-ntwrk/wallet-sdk-shielded": "2.1.0",
    "@midnight-ntwrk/wallet-sdk-unshielded-wallet": "2.1.0",
    "effect": "^3.19.19",
    "@scure/bip39": "2.0.1",
    "ws": "8.18.3",
    "rxjs": "7.8.2"
  },
  "resolutions": {
    "@midnight-ntwrk/ledger-v8": "8.0.3",
    "@midnight-ntwrk/midnight-js-network-id": "4.0.4",
    "@midnight-ntwrk/compact-js": "2.5.0"
  }
}
```

> **CRITICAL**: Pin `@midnight-ntwrk/compact-js` to the exact same version used by
> `@midnight-ntwrk/midnight-js-contracts` (e.g., `2.5.0`). Different versions use
> different `Symbol()` TypeIds, causing `CompiledContract` objects to be unrecognized
> across package boundaries.

> **CRITICAL**: Pin `@midnight-ntwrk/ledger-v8` to the exact version used by the wallet
> SDK (e.g., `8.0.3`). Version mismatches cause `instanceof DustParameters` failures
> due to separate WASM module instances.

> **CRITICAL — Bun**: With `wallet-sdk-facade@3.0.0`, the published bundle imports
> `effect` directly but does not declare it as a dependency. Add `effect` and
> `wallet-sdk-capabilities` as direct deps and set `linker = "hoisted"` in
> `bunfig.toml` so transitive resolution works under bun's isolated installer.

### Provider Setup (Browser - Lace Wallet)

```typescript
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider'

async function setupProviders() {
  const wallet = window.midnight?.mnLace
  const walletAPI = await wallet.enable()
  const walletState = await walletAPI.state()
  const uris = await wallet.serviceUriConfig()

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'owlid-state',
    }),
    zkConfigProvider: new FetchZkConfigProvider(window.location.origin, fetch),
    proofProvider: httpClientProofProvider(uris.proverServerUri),
    publicDataProvider: indexerPublicDataProvider(uris.indexerUri, uris.indexerWsUri),
    walletProvider: {
      getCoinPublicKey: () => walletState.coinPublicKey,
      getEncryptionPublicKey: () => walletState.encryptionPublicKey,
      balanceTx: (tx, newCoins) => walletAPI.balanceAndProveTransaction(tx, newCoins),
    },
    midnightProvider: {
      submitTx: (tx) => walletAPI.submitTransaction(tx),
    },
  }
}
```

> **NOTE**: `walletProvider` uses **getter functions** `getCoinPublicKey()` and
> `getEncryptionPublicKey()`, not plain properties. This changed in the SDK v3.1.0 API.

### Provider Setup (Server-Side - Headless Wallet v2.0.0)

> **BREAKING CHANGE in v2.0.0**: `WalletFacade` constructor is now **private**.
> You MUST use `WalletFacade.init()` static async method with a `DefaultConfiguration` object.

```typescript
import * as ledger from '@midnight-ntwrk/ledger-v8'
import { type DefaultConfiguration, WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade'
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet'
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd'
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded'
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet'
import {
  DustAddress,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format'
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { WebSocket } from 'ws'
import * as Rx from 'rxjs'

// CRITICAL: Polyfill WebSocket BEFORE any wallet SDK imports
// @ts-expect-error Required for GraphQL subscriptions via graphql-ws
globalThis.WebSocket = WebSocket

// 1. Set network ID (MUST be called before any wallet operations)
setNetworkId('undeployed') // or 'preprod'
const networkId = 'undeployed'

// 2. HD Key derivation from seed
const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'))
if (hdWallet.type !== 'seedOk') throw new Error('Failed to initialize HDWallet')

const derivation = hdWallet.hdWallet
  .selectAccount(0)
  .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
  .deriveKeysAt(0)
if (derivation.type !== 'keysDerived') throw new Error('Failed to derive keys')

hdWallet.hdWallet.clear() // Clean up seed material

// 3. Create secret keys from derived roles
const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivation.keys[Roles.Zswap])
const dustSecretKey = ledger.DustSecretKey.fromSeed(derivation.keys[Roles.Dust])
const unshieldedKeystore = createKeystore(derivation.keys[Roles.NightExternal], networkId)

// 4. Build DefaultConfiguration (v2.0.0 pattern)
const configuration: DefaultConfiguration = {
  networkId,
  indexerClientConnection: {
    indexerHttpUrl: 'http://localhost:8088/api/v3/graphql',
    indexerWsUrl: 'ws://localhost:8088/api/v3/graphql/ws',
  },
  provingServerUrl: new URL('http://localhost:6300'),
  relayURL: new URL('ws://localhost:9944'),
  costParameters: {
    additionalFeeOverhead: 300_000_000_000_000n,
    feeBlocksMargin: 5,
  },
  txHistoryStorage: new InMemoryTransactionHistoryStorage(),
}

// 5. Initialize via WalletFacade.init() (NOT new WalletFacade())
const facade: WalletFacade = await WalletFacade.init({
  configuration,
  shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
  unshielded: (cfg) =>
    UnshieldedWallet(cfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(unshieldedKeystore)),
  dust: (cfg) =>
    DustWallet(cfg).startWithSecretKey(
      dustSecretKey,
      ledger.LedgerParameters.initialParameters().dust,
    ),
})

// 6. Start sync (REQUIRED — without this, isSynced never becomes true)
await facade.start(shieldedSecretKeys, dustSecretKey)

// 7. Wait for sync
const state = await Rx.firstValueFrom(
  facade.state().pipe(
    Rx.throttleTime(5_000),
    Rx.filter((s) => s.isSynced),
  ),
)
// state.isSynced === true, wallet is ready

// 8. Get wallet addresses (v2.0.0 typed address objects)
const unshieldedAddr = unshieldedKeystore.getBech32Address().asString()
const shieldedAddr = MidnightBech32m.encode(networkId, state.shielded.address).asString()
const dustAddr = DustAddress.encodePublicKey(networkId, dustSecretKey.publicKey)

// 9. Check balances
const unshielded = state.unshielded?.balances[ledger.nativeToken().raw] ?? 0n
const shielded = state.shielded?.balances[ledger.nativeToken().raw] ?? 0n
const dust = state.dust?.balance(new Date()) ?? 0n
```

> **CRITICAL**: `WalletFacade.init()` takes factory functions `(cfg) => SubWallet(cfg).startWith...()`
> for each sub-wallet. The configuration is distributed to each sub-wallet by the facade.

> **CRITICAL**: You MUST call `facade.start(shieldedSecretKeys, dustSecretKey)` after `init()`.
> Without this, the wallet's background sync fibers never start, and `isSynced` never becomes `true`.

### DUST Registration (Required Before Transactions)

Before any wallet can pay transaction fees, its NIGHT UTXOs must be registered for DUST generation:

```typescript
// Find unregistered NIGHT UTXOs
const walletState = await Rx.firstValueFrom(facade.state().pipe(Rx.filter((s) => s.isSynced)))
const unregisteredUtxos =
  walletState.unshielded?.availableCoins.filter(
    (coin) => coin.meta.registeredForDustGeneration === false,
  ) ?? []

if (unregisteredUtxos.length > 0) {
  // Register for dust generation
  const recipe = await facade.registerNightUtxosForDustGeneration(
    unregisteredUtxos,
    unshieldedKeystore.getPublicKey(),
    (payload) => unshieldedKeystore.signData(payload),
  )
  const finalized = await facade.finalizeRecipe(recipe)
  const txId = await facade.submitTransaction(finalized)

  // Wait for dust to appear
  await Rx.firstValueFrom(
    facade.state().pipe(Rx.filter((s) => (s.dust?.balance(new Date()) ?? 0n) > 0n)),
  )
}
```

### NIGHT Token Transfers

```typescript
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format'

const ttl = new Date(Date.now() + 30 * 60 * 1000) // 30 min TTL

const recipe = await facade.transferTransaction(
  [
    {
      type: 'unshielded',
      outputs: [
        {
          type: ledger.nativeToken().raw,
          receiverAddress, // UnshieldedAddress object
          amount: 50_000n * 10n ** 6n, // 50,000 NIGHT
        },
      ],
    },
  ],
  { shieldedSecretKeys, dustSecretKey },
  { ttl },
)

const signed = await facade.signRecipe(recipe, (payload) => unshieldedKeystore.signData(payload))
const finalized = await facade.finalizeRecipe(signed)
const txId = await facade.submitTransaction(finalized)
```

> **NOTE**: On devnet with `CFG_PRESET=dev`, the genesis seed
> `0000000000000000000000000000000000000000000000000000000000000001` has pre-minted tokens.

---

## 15. Infrastructure

### Docker Images

| Image                              | Version | Port | Purpose                                 |
| ---------------------------------- | ------- | ---- | --------------------------------------- |
| `midnightntwrk/midnight-node`      | 0.22.3  | 9944 | Substrate node (WS RPC)                 |
| `midnightntwrk/indexer-standalone` | 4.0.1   | 8088 | GraphQL indexer (blocks, events, state) |
| `midnightntwrk/proof-server`       | 8.0.3   | 6300 | ZK proof generation server              |

> **Version source**: [midnightntwrk/midnight-local-dev](https://github.com/midnightntwrk/midnight-local-dev) — the official local dev environment repo.

### Local Development Stack

The official reference is `standalone.yml` from `midnight-local-dev`. Our `docker-compose.midnight.yml` mirrors it:

```yaml
# docker-compose.midnight.yml (aligned with midnight-local-dev/standalone.yml)
services:
  midnight-node:
    image: midnightntwrk/midnight-node:0.22.3
    container_name: owlid-midnight-node
    ports: ['9944:9944']
    environment:
      CFG_PRESET: 'dev'
      SIDECHAIN_BLOCK_BENEFICIARY: '04bcf7ad3be7a5c790460be82a713af570f22e0f801f6659ab8e84a52be6969e'
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:9944/health']
      interval: 2s
      timeout: 5s
      retries: 20
      start_period: 20s

  midnight-indexer:
    image: midnightntwrk/indexer-standalone:4.0.1
    container_name: owlid-midnight-indexer
    ports: ['8088:8088']
    env_file: midnight.env.example
    environment:
      RUST_LOG: 'indexer=info,chain_indexer=info,indexer_api=info,wallet_indexer=info,indexer_common=info,fastrace_opentelemetry=off,info'
      APP__APPLICATION__NETWORK_ID: 'undeployed'
    healthcheck:
      test: ['CMD-SHELL', 'cat /var/run/indexer-standalone/running']
      interval: 10s
      timeout: 5s
      retries: 20
      start_period: 10s
    depends_on:
      midnight-node: { condition: service_healthy }

  proof-server:
    image: midnightntwrk/proof-server:8.0.3
    container_name: owlid-proof-server
    command: ['midnight-proof-server -v']
    ports: ['6300:6300']
    environment:
      RUST_LOG: 'info'
      RUST_BACKTRACE: 'full'
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:6300/version']
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 10s
```

### Indexer Environment Variables

The indexer requires an env file (`midnight.env.example`). These are the dev defaults from
the official `standalone.env.example`:

```bash
# midnight.env.example
APP__INFRA__NODE__URL=ws://midnight-node:9944
APP__INFRA__STORAGE__PASSWORD=indexer
APP__INFRA__PUB_SUB__PASSWORD=indexer
APP__INFRA__LEDGER_STATE_STORAGE__PASSWORD=indexer
APP__INFRA__SECRET=303132333435363738393031323334353637383930313233343536373839303132
```

> **WARNING**: `APP__INFRA__SECRET` must be a valid 64-char hex string. Placeholder values like
> `your-hex-secret-here` will crash the indexer on startup.

### Network Endpoints

> **CRITICAL**: The indexer v3 uses separate HTTP and WebSocket paths!

| Network | Indexer HTTP                                              | Indexer WS                                                 | Node WS                              |
| ------- | --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Local   | `http://localhost:8088/api/v3/graphql`                    | `ws://localhost:8088/api/v3/graphql/ws`                    | `ws://localhost:9944`                |
| Preview | `https://indexer.preview.midnight.network/api/v3/graphql` | `wss://indexer.preview.midnight.network/api/v3/graphql/ws` | `wss://rpc.preview.midnight.network` |
| Preprod | `https://indexer.preprod.midnight.network/api/v3/graphql` | `wss://indexer.preprod.midnight.network/api/v3/graphql/ws` | `wss://rpc.preprod.midnight.network` |

> **NOTE**: The old `/api/v1/graphql` endpoints return `308 Permanent Redirect` to `/api/v3/graphql`.
> The v1 WS path does NOT work — use `/api/v3/graphql/ws` for WebSocket subscriptions.

> **NOTE**: The wallet SDK derives the WS URL from the HTTP URL by appending `/ws` if
> `indexerWsUrl` is not provided. Always provide `indexerWsUrl` explicitly to avoid confusion.

### Networks

| Network    | Purpose         | Network ID   | Faucet                                   |
| ---------- | --------------- | ------------ | ---------------------------------------- |
| Standalone | Local Docker    | `undeployed` | Auto-funded (genesis seed)               |
| Preview    | Preview testnet | `preview`    | --                                       |
| Preprod    | Public testnet  | `preprod`    | https://faucet.preprod.midnight.network/ |

### Wallet

- **Lace Beta** (Chrome extension) for Midnight browser DApps
- Exposes `window.midnight.mnLace` for DApp connection
- Handles signing, ZK proving, and transaction submission
- **Headless Wallet** (server-side) uses `wallet-sdk-*` packages (see Section 14)

### Genesis Wallet & Funding (Local Dev)

On a local devnet (`CFG_PRESET=dev`), the genesis seed has pre-minted tokens:

```
GENESIS_MINT_WALLET_SEED = 0000000000000000000000000000000000000000000000000000000000000001
```

The [midnight-local-dev](https://github.com/midnightntwrk/midnight-local-dev) repo provides a
funding script that:

1. Creates a master wallet from the genesis seed
2. Registers DUST tokens (required for transaction fees)
3. Funds test accounts with 50,000 NIGHT each (in smallest denomination: 50,000 \* 10^6)

> **IMPORTANT**: DUST registration requires the wallet to have synced and found its NIGHT UTXOs.
> Wait for `isSynced` to become `true` before attempting any funding or contract deployment.

To build a headless wallet from the genesis seed:

```typescript
import { WalletBuilder } from '@midnight-ntwrk/wallet-sdk-facade'
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'

setNetworkId('undeployed') // MUST be called before any wallet operations

const wallet = await WalletBuilder.build(
  indexerPublicDataProvider(
    'http://localhost:8088/api/v3/graphql',
    'ws://localhost:8088/api/v3/graphql/ws',
  ),
  httpClientProofProvider('http://localhost:6300', zkConfigProvider),
  'ws://localhost:9944',
  GENESIS_MINT_WALLET_SEED,
)
await wallet.start() // Start background sync — without this, isSynced never becomes true
```

### Wallet SDK Packages (v2.0.0)

The official local dev uses these wallet packages:

| Package                                        | Version  | Purpose                          |
| ---------------------------------------------- | -------- | -------------------------------- |
| `@midnight-ntwrk/wallet-sdk-facade`            | 3.0.0    | Main wallet interface            |
| `@midnight-ntwrk/wallet-sdk-abstractions`      | 2.0.0    | Type definitions                 |
| `@midnight-ntwrk/wallet-sdk-capabilities`      | 3.2.0    | Wallet capability runtime        |
| `@midnight-ntwrk/wallet-sdk-dust-wallet`       | 3.0.0    | DUST token handling              |
| `@midnight-ntwrk/wallet-sdk-shielded`          | 2.1.0    | Shielded transactions            |
| `@midnight-ntwrk/wallet-sdk-unshielded-wallet` | 2.1.0    | Unshielded (public) transactions |
| `@midnight-ntwrk/wallet-sdk-hd`                | 3.0.1    | HD key derivation                |
| `@midnight-ntwrk/wallet-sdk-address-format`    | 3.1.0    | Address encoding/decoding        |
| `@midnight-ntwrk/ledger-v8`                    | 8.0.3    | Ledger WASM bindings             |
| `@midnight-ntwrk/midnight-js-network-id`       | 4.0.4    | Network ID configuration         |
| `@midnight-ntwrk/midnight-js-contracts`        | 4.0.4    | Contract deploy/find runtime     |
| `@midnight-ntwrk/compact-js`                   | 2.5.0    | CompiledContract pipeline        |
| `@midnight-ntwrk/compact-runtime`              | 0.16.0   | Generated contract runtime       |
| `effect`                                       | ^3.19.19 | Required transitive of facade    |

---

## 16. Code Examples

### Simple Counter

```compact
pragma language_version >= 0.21.0;
import CompactStandardLibrary;

export ledger round: Counter;

export circuit increment(): [] {
  round.increment(1);
}
```

### Access Control Pattern

```compact
pragma language_version >= 0.21.0;
import CompactStandardLibrary;

export { ZswapCoinPublicKey, ContractAddress, Either, Maybe };

export ledger owner: Either<ZswapCoinPublicKey, ContractAddress>;

constructor(initialOwner: Either<ZswapCoinPublicKey, ContractAddress>) {
  owner = disclose(initialOwner);
}

export circuit assertOnlyOwner(): [] {
  const caller = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
  assert(caller == owner, "Not the owner");
}

export circuit transferOwnership(newOwner: Either<ZswapCoinPublicKey, ContractAddress>): [] {
  assertOnlyOwner();
  owner = disclose(newOwner);
}
```

### Witness Pattern (Bulletin Board)

```compact
pragma language_version >= 0.21.0;
import CompactStandardLibrary;

export enum State { VACANT, OCCUPIED }

export ledger state: State;
export ledger message: Maybe<Opaque<"string">>;
export ledger owner: Bytes<32>;
export ledger sequence: Counter;

witness localSecretKey(): Bytes<32>;

circuit publicKey(sk: Bytes<32>, seq: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<3, Bytes<32>>>([pad(32, "bboard:pk:"), seq, sk]);
}

constructor() {
  state = State.VACANT;
  message = none<Opaque<"string">>();
  sequence.increment(1);
}

export circuit post(newMessage: Opaque<"string">): [] {
  assert(state == State.VACANT, "Board is occupied");
  owner = disclose(publicKey(localSecretKey(), sequence as Field as Bytes<32>));
  message = disclose(some<Opaque<"string">>(newMessage));
  state = State.OCCUPIED;
}

export circuit takeDown(): Opaque<"string"> {
  assert(state == State.OCCUPIED, "Board is empty");
  assert(owner == publicKey(localSecretKey(), sequence as Field as Bytes<32>), "Not the owner");
  const msg = message.value;
  state = State.VACANT;
  sequence.increment(1);
  message = none<Opaque<"string">>();
  return msg;
}
```

### Token Pattern (OpenZeppelin FungibleToken-like)

```compact
pragma language_version >= 0.21.0;
import CompactStandardLibrary;
export { ZswapCoinPublicKey, ContractAddress, Either, Maybe };

export ledger _name: Opaque<"string">;
export ledger _symbol: Opaque<"string">;
export ledger _decimals: Uint<8>;
export ledger _totalSupply: Counter;
export ledger _balances: Map<Either<ZswapCoinPublicKey, ContractAddress>, Uint<128>>;

constructor(name: Opaque<"string">, symbol: Opaque<"string">, decimals: Uint<8>) {
  _name = disclose(name);
  _symbol = disclose(symbol);
  _decimals = disclose(decimals);
}

export circuit balanceOf(account: Either<ZswapCoinPublicKey, ContractAddress>): Uint<128> {
  if (_balances.member(disclose(account))) {
    return _balances.lookup(account);
  }
  return 0 as Uint<128>;
}

export circuit transfer(to: Either<ZswapCoinPublicKey, ContractAddress>, value: Uint<128>): [] {
  const caller = left<ZswapCoinPublicKey, ContractAddress>(ownPublicKey());
  const fromBalance = balanceOf(caller);
  assert(fromBalance >= value, "Insufficient balance");
  _balances.insert(disclose(caller), disclose(fromBalance - value as Uint<128>));

  if (!_balances.member(disclose(to))) {
    _balances.insert(disclose(to), disclose(value));
  } else {
    const toBalance = balanceOf(to);
    _balances.insert(disclose(to), disclose(toBalance + value as Uint<128>));
  }
}
```

---

## 17. NightID Contract Design

### Contracts Needed

Based on the OwlID architecture (replacing Solidity EVM contracts):

#### 1. `IssuerRegistry.compact`

Manages trusted credential issuers.

- **Ledger**: Map of issuer public keys → status (active/deactivated)
- **Circuits**: registerIssuer, deactivateIssuer, reactivateIssuer, isTrusted
- **Access**: Owner-gated registration, public trust queries

#### 2. `RevocationRegistry.compact`

Tracks credential revocation status.

- **Ledger**: Map of root hashes → revocation status
- **Circuits**: revoke, suspend, reactivate, isRevoked, getStatus
- **Privacy**: Root hashes only (no PII), status publicly queryable

#### 3. `IdentityRegistry.compact`

Anchors DIDs and Merkle root commitments on-chain.

- **Ledger**: Map of DID hashes → root hash commitments, MerkleTree for commitment history
- **Circuits**: registerIdentity, updateCommitment, verifyCommitment
- **Privacy**: Only cryptographic commitments stored, never raw identity data
- **Witnesses**: For providing private identity data during proof generation

#### 4. `predicate_<kind>.compact` (seven per-predicate contracts)

Chain-attested zero-knowledge predicates — one Compact contract per kind
(`predicate_{kyc,email,age,age_range,nationality,residency,personhood}`),
forced by Midnight's per-extrinsic deploy-weight cap.

- **Ledger** (each): `attestations: Set<Bytes<32>>` + `attestTree:
HistoricMerkleTree` + `attestCount`; `personhood` adds a `nullifiers` set.
- **Circuits**: `attest{KycGte,EmailVerified,AgeGte,AgeRange,NationalityIn,
ResidencyIn,UniquePersonhood}`, `isAttested`, plus Ownable/Pausable.
- **Witnesses**: the claim value (e.g. `kycLevel`, `dobValue`) **plus the
  F-1 binding witness** `claimSalt` + `claimPath` — a `MerkleTreePath` proving
  the value is a leaf under the issuer-signed `owl_root`. The circuit opens it
  before the predicate check, so a fabricated value has no valid path.
- **Verify model**: the Midnight node verifies the proof in consensus; a
  session-independent key `persistentHash(tag‖owl_root‖param)` is recorded
  only for a valid proof. The verifier recomputes the key off-chain from the
  issuer-signed `owl_root` and checks an SSE-mirrored set (no chain in the
  hot path).

> All contracts inherit the vendored OpenZeppelin Compact stdlib
> (`contracts/lib`: Ownable/Pausable/Initializable). Holder predicate
> proving runs on the device in-process (zkir-v2 WASM). See
> [`MIDNIGHT.md`](./MIDNIGHT.md).

### Key Design Principles

1. **Never store PII on-chain** — only Merkle root commitments and hashes
2. **Issuer registry is public** — anyone can verify if an issuer is trusted
3. **Revocation is public** — verifiers can check credential status
4. **Identity commitments use witnesses** — private data stays off-chain
5. **Use `persistentHash`** for all on-chain hashes (deterministic, cross-DApp)
6. **Use `disclose`** explicitly for all ledger writes from private data

---

## 18. Language Constraints (Important!)

From real code analysis and compilation:

- **No dynamic loops** — only constant-range iteration (`for (const i of 0..1023)`); range bounds may be generic params since 0.31
- **Max Uint is `Uint<0..2^248-1>`** — the language max is 2^248−1 (reduced from ~2^254 in 0.27). `Uint<128>` is an OwlID convention, not a language limit; `Uint<248>` etc. are valid
- **No contract-to-contract calls** — contracts cannot call other contracts (yet); the `contract` keyword is reserved but the call path errors `cross-contract calls are not yet supported`
- **No Map iteration** — cannot iterate over Map keys in-circuit
- **No dynamic arrays** — fixed-size `Vector<N, T>` only
- **Vector indexing** — only constant indices (`vector[0]`), not variable (`vector[i]`)
- **`MerkleTree.root()` is runtime-only** — cannot call in a circuit, access via TS
- **All ledger ops need `disclose()`** — `member()`, `lookup()`, `insert()`, `remove()` args from witness/params must be disclosed
- **Can't cast `Bytes<N>` to `Opaque<"string">`** — use `remove()` or proper types
- **Bounded computation** — all circuits must have fixed computational bounds at compile time

---

## 19. Advanced Patterns (from OpenZeppelin)

### Sealed Ledger (Immutable)

```compact
export sealed ledger _name: Opaque<"string">;  // Set once in constructor, never changed
```

### Pure Circuits (No State)

```compact
export pure circuit isKeyZero(key: ZswapCoinPublicKey): Boolean {
  return key.bytes == default<Bytes<32>>;
}
```

### Struct Types

```compact
export struct DivResultU128 {
  quotient: Uint<128>,
  remainder: Uint<128>
}
```

### Module System (Composable Contracts)

```compact
module Pausable {
  export ledger _isPaused: Boolean;
  export circuit assertNotPaused(): [] { assert(!_isPaused, "Paused"); }
}
```

### Generic Modules

```compact
module Queue<T> {
  export ledger state: Map<Uint<64>, T>;
  export circuit enqueue(item: T): [] { ... }
}
```

### MerkleTree Path Verification

```compact
// Off-chain: get path via witness
export witness wit_getRoleMerklePath(commit: Bytes<32>): Maybe<MerkleTreePath<10, Bytes<32>>>;

// In-circuit: verify root
circuit getPathRoot(path: MerkleTreePath<10, Bytes<32>>): MerkleTreeDigest {
  return merkleTreePathRoot<10, Bytes<32>>(path);
}

// Verify membership:
roleCommits.checkRoot(getPathRoot(path))
```

---

## 20. Version Changelog (0.27 → 0.31)

### Compact 0.27.0 (Language 0.19.0, Dec 2025)

- **Type aliases**: `type Name = Type;` (structural) and `new type Name = Type;` (nominal/opaque)
- **Selective imports**: `import { getMatch, putMatch as $putMatch } from Matching;`
- **Unshielded token ops**: `mintUnshieldedToken`, `sendUnshielded`, `receiveUnshielded`, `unshieldedBalance`
- **BREAKING**: `Uint` ranges now exclusive: `Uint<0..3>` = {0,1,2} not {0,1,2,3}. Use `--update-Uint-ranges` fixup
- **BREAKING**: Max Uint reduced from ~2^254 to 2^248 - 1
- **BREAKING**: `CoinInfo` → `ShieldedCoinInfo`, `QualifiedCoinInfo` → `QualifiedShieldedCoinInfo`
- **BREAKING**: `return` in `for` loops now a static error
- ESM output instead of CommonJS
- Compiler skips ZKIR/proving keys for circuits that don't touch ledger

### Compact 0.28.0 (Language 0.20.0, Jan 2026)

- Targets **ledger v7** (Preprod/Preview). NOT compatible with testnet-02
- **BREAKING**: `CurvePoint` → `NativePoint` (nominal type). Use `NativePointX`/`NativePointY` accessors
- `constructNativePoint` circuit for building from coordinates

### Compact 0.29.0 (Language 0.21.0, Feb 2026)

- `contract-info.json` includes version strings + per-circuit proof-requirement flags
- ARM Linux binary available
- **BREAKING**: `NativePointX` → `nativePointX`, `NativePointY` → `nativePointY` (use `compact fixup`)
- External circuit syntax (bodyless circuits) removed
- **Fix**: Exponential compile time for `MerkleTree.checkRoot` at high depth
- **Fix**: Repeated witness disclosure analysis now correct, messages ordered by severity
- **Fix**: `ChargedState` copy bug passing junk metadata to deployments
- Last toolchain targeting **ledger v7**

### Compact 0.30.0 (Language 0.22.0, runtime 0.15.0, Mar 2026)

- **BREAKING**: targets **ledger v8** — contracts for a ledger-8 chain need 0.30+; ledger-7 chains must stay on 0.29
- **BREAKING**: `NativePoint` → `JubjubPoint`
- New compiler flags: `--ledger-version`, `--runtime-version`, `--compact-path`, `--trace-search`
- New search order for `include`d files and file-imported modules
- Compiler error to use `persistentHash` / `persistentCommit` on JS opaque values
- Release notes shipped inside the release artifacts

### Compact 0.31.0 (Language 0.23.0, runtime 0.16.0, Apr 2026) — CURRENT

- Workarounds so operations in untaken conditional branches cannot cause erroneous proof failures (may increase circuit size)
- `for` loop range bounds may now be generic parameters
- `contract-info.json` now describes the public ledger-state layout (field name, index, exported, storage type, type args) — readable by language-agnostic tooling
- Compact language reference fully revised, now matches the current language version
- **BREAKING**: Compact runtime `convertBytesToUint` — `maxval` param type `number` → `bigint`

### Post-0.31.0 (toolchain 0.31.10x point releases)

- `keccak256` added to the standard library + runtime, same signature as `persistentHash`. Requires the experimental `--feature-zkir-v3` flag when used in a circuit that touches public ledger state; compiler error under the ZKIR v2 backend
- `eval` and `arguments` reserved as future reserved words (JS strict-mode collision)

---

## 21. Testing Compact Contracts

### Simulator Pattern

```typescript
import {
  type CircuitContext,
  sampleContractAddress,
  createConstructorContext,
  QueryContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime'
import { Contract, type Ledger, ledger } from '../managed/my_contract/contract/index.js'

class MyContractSimulator {
  readonly contract: Contract<PrivateState>
  circuitContext: CircuitContext<PrivateState>

  constructor(owner: Either<ZswapCoinPublicKey, ContractAddress>, coinPubKey: string) {
    this.contract = new Contract<PrivateState>(witnesses)
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      this.contract.initialState(createConstructorContext(privateState, coinPubKey), owner)
    this.circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      costModel: CostModel.initialCostModel(),
      currentQueryContext: new QueryContext(currentContractState.data, sampleContractAddress()),
    }
  }

  getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state)
  }

  myCircuit(arg: Uint8Array): Ledger {
    this.circuitContext = this.contract.impureCircuits.myCircuit(this.circuitContext, arg).context
    return this.getLedger()
  }
}
```

### Owner Authentication in Tests

The `assertOnlyOwner()` guard compares `ownPublicKey(context)` (from zswap state) with the ledger owner.
The owner's `left.bytes` must match `encodeCoinPublicKey(coinPublicKeyHex)`:

```typescript
import { encodeCoinPublicKey } from '@midnight-ntwrk/onchain-runtime-v2'
const COIN_KEY = '0'.repeat(64)
const owner = {
  is_left: true,
  left: { bytes: encodeCoinPublicKey(COIN_KEY) },
  right: { bytes: new Uint8Array(32) },
}
const sim = new MySimulator(owner, COIN_KEY) // coinPubKey must match owner bytes
```

### Witness Mocking

For contracts with witnesses (e.g. `ownerSecretKey`), create a typed witness object:

```typescript
const witnesses: Witnesses<MyPrivateState> = {
  ownerSecretKey: (context) => [context.privateState, context.privateState.secretKey],
}
```

---

## 22. Deployment & DApp Integration

### CompiledContract Pipeline

```typescript
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { Contract as MyContract } from './managed/my_contract/contract/index.js'

// Without witnesses
const compiledContract = CompiledContract.make('my-contract', MyContract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets('/path/to/managed/my_contract'),
)

// With witnesses (e.g., identity registry with ownerSecretKey)
import { createWitnesses } from './witnesses.js'
const compiledContract = CompiledContract.make('identity-registry', IdentityContract).pipe(
  CompiledContract.withWitnesses(createWitnesses(secretKey)),
  CompiledContract.withCompiledFileAssets('/path/to/managed/identity_registry'),
)
```

> **CRITICAL**: The path passed to `withCompiledFileAssets` must contain a `keys/` subdirectory
> with `*.verifier` and `*.prover` files, and a `zkir/` subdirectory with `*.bzkir` files.
> These are generated by `compact compile` WITHOUT the `--skip-zk` flag. Compiling with
> `--skip-zk` only generates `.zkir` text files, which are NOT sufficient for deployment.

> **CRITICAL**: `CompiledContract.make()` takes the **Contract class** itself (not an instance).
> `new Contract(witnesses)` is only used for tests/simulators. For deployment, always use
> `CompiledContract.make('tag', ContractClass)`.

### Six Required Providers

> **BREAKING CHANGE (v3.x)**: The provider APIs changed significantly between v2 and v3.
> `levelPrivateStateProvider` now requires `accountId` and `privateStoragePasswordProvider`.
> `httpClientProofProvider` now takes `(url, zkConfigProvider)` instead of just `(url)`.
> `FetchZkConfigProvider<K>` now requires a type parameter.

```typescript
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
// or for browser:
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';

// Node.js (filesystem-based ZK config)
const zkConfigProvider = new NodeZkConfigProvider<string>('/path/to/managed/my_contract');

// Browser (HTTP-based ZK config)
// const zkConfigProvider = new FetchZkConfigProvider<string>(baseUrl, fetch.bind(window));

const providers = {
  privateStateProvider: levelPrivateStateProvider({
    privateStateStoreName: 'my-state',
    accountId: 'my-account-id',                       // NEW in v3: required scoping key
    privateStoragePasswordProvider: () => 'password',  // NEW in v3: required encryption password
  }),
  publicDataProvider: indexerPublicDataProvider(
    'http://localhost:8088/api/v3/graphql',
    'ws://localhost:8088/api/v3/graphql/ws',
  ),
  zkConfigProvider,
  proofProvider: httpClientProofProvider(proofServerUrl, zkConfigProvider), // v3: 2 args required
  walletProvider: {
    coinPublicKey,            // v3: direct property (was getCoinPublicKey() in v2)
    encryptionPublicKey,      // v3: direct property (was getEncryptionPublicKey() in v2)
    balanceTx: async (tx, newCoins) => { ... },
  },
  midnightProvider: {
    submitTx: async (tx) => { ... },
  },
};
```

> **NOTE**: `NodeZkConfigProvider` expects:
>
> - `keys/<circuitId>.verifier` — verifier keys (for deployment)
> - `keys/<circuitId>.prover` — prover keys (for local proving)
> - `zkir/<circuitId>.bzkir` — binary ZKIR (for proof server)
>
> `FetchZkConfigProvider` fetches the same files over HTTP (for browser environments).

> **NOTE**: `levelPrivateStateProvider` v3 config interface:
>
> ```typescript
> interface LevelPrivateStateProviderConfig {
>   midnightDbName: string // LevelDB database name
>   privateStateStoreName: string // Object store for private states
>   signingKeyStoreName: string // Object store for signing keys
>   privateStoragePasswordProvider: () => string | Promise<string> // Min 16 chars
>   accountId: string // Scoping key for multi-account support
> }
> ```

### Deploy with Constructor Arguments

```typescript
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts'

// Contracts with constructors (like OwlID registries) need `args`
// The constructor signature: constructor(initialOwner: Either<ZswapCoinPublicKey, ContractAddress>)
// The SDK injects constructorContext automatically; you provide the remaining args.
const initialOwner = {
  is_left: true,
  left: { bytes: new Uint8Array(Buffer.from(coinPublicKey, 'hex')) },
  right: { bytes: new Uint8Array(32) },
}

const deployed = await deployContract(providers, {
  compiledContract,
  privateStateId: 'my-state',
  initialPrivateState: {},
  args: [initialOwner], // Constructor args AFTER the auto-injected constructorContext
})

// deployed.deployTxData.public.contractAddress
```

### Join Existing Contract

```typescript
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts'

const contract = await findDeployedContract(providers, {
  contractAddress: '0x...',
  compiledContract,
  privateStateId: 'my-state',
  initialPrivateState: {},
})
```

### Calling Circuits (callTx)

```typescript
// Each impure circuit is callable via callTx
// Flow: execute locally → prove → balance → submit → wait for finalization
const result = await contract.callTx.increment()
// result.public.txId, result.public.blockHeight

// With arguments
await contract.callTx.registerIssuer(publicKey, name)
```

### Ledger State Access

```typescript
// Direct query
const contractState = await providers.publicDataProvider.queryContractState(address)
const ledgerState = MyContract.ledger(contractState.data)

// Reactive (RxJS Observable)
providers.publicDataProvider
  .contractStateObservable(address, { type: 'latest' })
  .pipe(map((state) => MyContract.ledger(state.data)))
  .subscribe((ledger) => {
    /* react to changes */
  })
```

### Known Deployment Issues

| Issue                                                              | Cause                                                                       | Fix                                                           |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `compiledContract[TypeId]` is undefined                            | `compact-js` version mismatch between your code and `midnight-js-contracts` | Pin to same version                                           |
| `context.ctor` is undefined                                        | Same as above                                                               | Same                                                          |
| `expected 2 arguments, received 1`                                 | Contract constructor needs args (e.g., `initialOwner`)                      | Pass `args: [initialOwner]`                                   |
| `ZKConfigurationReadError: Failed to read verifier key`            | Compiled with `--skip-zk`, missing `keys/*.verifier` files                  | Recompile without `--skip-zk`                                 |
| `expected instance of DustParameters`                              | `ledger-v8` version mismatch (two WASM instances)                           | Pin `ledger-v8` to exact version (8.0.3) used by wallet SDK   |
| `isSynced` never becomes true                                      | Missing `facade.start()` call OR wrong indexer URL                          | Call `start()`, use `/api/v3/graphql/ws`                      |
| `Expected 2 arguments, but got 1` on `httpClientProofProvider`     | v3 API change: now requires `(url, zkConfigProvider)`                       | Pass zkConfigProvider as second arg                           |
| `Missing properties: privateStoragePasswordProvider, accountId`    | v3 API change: `levelPrivateStateProvider` config changed                   | Add required `accountId` and `privateStoragePasswordProvider` |
| `Generic type 'FetchZkConfigProvider<K>' requires 1 type argument` | v3 API change: type param now required                                      | Use `FetchZkConfigProvider<string>`                           |
| Indexer returns 308 redirect                                       | Using old `/api/v1/graphql` endpoint                                        | Use `/api/v3/graphql` (v1 is deprecated)                      |
| Indexer crashes on startup                                         | `APP__INFRA__SECRET` is not valid hex                                       | Use 64-char hex string (see `standalone.env.example`)         |

### OwlID-Specific Notes

- **Proof server**: We use the official `midnightntwrk/proof-server:8.0.3` Docker image and
  `@midnight-ntwrk/midnight-js-http-client-proof-provider@4.0.4` as the client. No third-party
  fork required.

### Contract-to-Contract Calls

**Not yet supported.** The `contract` keyword is reserved for future cross-contract calls.
Inter-contract coordination must be done at the DApp layer in TypeScript.

---

## 23. OpenZeppelin Compact Contracts

The [OpenZeppelin/compact-contracts](https://github.com/OpenZeppelin/compact-contracts) repo provides battle-tested modules.

### Module Composition Pattern

```compact
import "./node_modules/@openzeppelin-compact/contracts/src/access/Ownable" prefix Ownable_;
import "./node_modules/@openzeppelin-compact/contracts/src/security/Pausable" prefix Pausable_;

constructor(owner: Either<ZswapCoinPublicKey, ContractAddress>) {
  Ownable_initialize(owner);
}

export circuit myProtectedCircuit(): [] {
  Ownable_assertOnlyOwner();
  Pausable_assertNotPaused();
  // ...
}
```

### Available Modules

| Module             | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `Ownable`          | Single-owner access control with transfer                         |
| `ZOwnablePK`       | Privacy-preserving ownership via commitments                      |
| `AccessControl`    | Role-based access (nested `Map<Bytes<32>, Map<Either, Boolean>>`) |
| `Pausable`         | Pause/unpause guard                                               |
| `Initializable`    | One-time initialization guard                                     |
| `FungibleToken`    | ERC20-like with `Uint<128>` balances                              |
| `NonFungibleToken` | NFT standard                                                      |
| `MultiToken`       | Multi-token standard                                              |

### ZOwnablePK (Privacy-Preserving Ownership)

Stores a **commitment** to the owner instead of the public key:

```compact
// id = SHA256(pk, secretNonce)
// commitment = SHA256(id, instanceSalt, counter, "ZOwnablePK:shield:")
export circuit assertOnlyOwner(): [] {
  const nonce = wit_secretNonce();
  const id = _computeOwnerId(callerAsEither, nonce);
  assert(_ownerCommitment == _computeOwnerCommitment(id, _counter), "not owner");
}
```

Counter increments on each transfer for unlinkability.

### Nested Map Initialization

```compact
// Must insert default inner map first, then insert into it
if (!_operatorRoles.member(disclose(roleId))) {
  _operatorRoles.insert(disclose(roleId),
    default<Map<Either<ZswapCoinPublicKey, ContractAddress>, Boolean>>);
}
_operatorRoles.lookup(roleId).insert(disclose(account), true);
```

### `sealed ledger` — Immutable After Init

```compact
export sealed ledger _name: Opaque<"string">;    // set in constructor, never changes
export sealed ledger _domain: Bytes<32>;
```

### `default<T>` for Zero Values

```compact
assert(didHash != default<Bytes<32>>, "Invalid zero value");
// Cleaner than: pad(32, "") as Bytes<32>
```

### Native Coin Operations

```compact
const coin = mintToken(_domain, disclose(amount), _nonce, disclose(recipient));
receive(disclose(coin));
const result = sendImmediate(disclose(coin), target, disclose(amount));
```

### HistoricMerkleTree vs MerkleTree

| Feature            | `MerkleTree<N, T>` | `HistoricMerkleTree<N, T>` |
| ------------------ | ------------------ | -------------------------- |
| Root history       | Current only       | All past roots             |
| `isHistoricRoot()` | No                 | Yes                        |
| Use case           | Current membership | Historical state proofs    |

---

## References

- [Official Docs](https://docs.midnight.network/compact)
- [Writing a Contract](https://docs.midnight.network/compact/writing)
- [GitHub: midnightntwrk](https://github.com/midnightntwrk)
- [Midnight Local Dev](https://github.com/midnightntwrk/midnight-local-dev) — Official local development environment (docker images, wallet funding, accounts)
- [OpenZeppelin Compact Contracts](https://github.com/OpenZeppelin/compact-contracts)
- [Compact by Example](https://compact-by-example.org/)
- [Example Counter](https://github.com/midnightntwrk/example-counter)
- [Example BBoard](https://github.com/midnightntwrk/example-bboard)
- [Midnight.js API](https://docs.midnight.network/api-reference/midnight-js)
- [MeshJS Midnight](https://meshjs.dev/midnight/midnight-contracts-wizard)
- [Midnight Academy](https://academy.midnight.network/)
