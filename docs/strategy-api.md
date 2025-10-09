
---

# API Contract: &nbsp; pool\_agent <--> sim\_core

Agent modules define a pool's behavior in response to network events. The [sim_engine](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/sim_engine.js) calls the registered `entryPoint` function, and passes it the current state. The agent must then return an object which informs the core on how to proceed.

### Function Signature

A strategy's entry point must conform to the following signature:
```javascript
function invokePoolAgent(activeEvent, pool, blocks) {
  // ... agent logic ...
  return { chaintip, timestamp, scores, broadcastIds };
}
```

---

### Parameters (Inputs)

The entry point receives three objects as arguments:

| Parameter | Description |
|---|---|
| `activeEvent` | An object containing details of the event this pool must process. |
| `pool` | A read-only object representing the current state of the pool. |
| `blocks` | A read-only object containing the full state of all simulated blocks, including orphans, and including blocks the pool might not be aware of yet. |

See the **Detailed Parameter Specifications** near the bottom for full specs on these parameters.

> **IMPORTANT: State Immutability**
> The `pool` and `blocks` objects are direct references to the global simulation state. **Do not mutate them directly.** Modifying these objects can corrupt the simulation state and produce invalid results. All state changes must be communicated through the `return` object.

---

### Return Value (Outputs)

The strategy function **MUST** return an object with the following properties (some can be 'null').

| Property | Type | Description |
|---|---|---|
| `chaintip` | string | `blockId` that the pool considers its new chaintip after processing the event. |
| `honTip` | string \| null | `blockId` that a *selfish miner* considers to be the public honest chaintip after processing the event. |
| `timestamp` | number \| null | **On `CREATE`:** The Unix timestamp for the new block. A strategy can manipulate this. <br> **On `RECV_OTHER`:** Must be `null`, as the received block already has a timestamp. |
| `scores` | object \| null | Unique view of what the pool believes about the block/network. See `Scores Specification`. |
| `requestIds` | Set() \| null | `blockIds` the pool identifies as missing, after processing the `activeEvent`. |
| `broadcastIds` | array \| null | `blockIds` to broadcast (or not), based on the pool's strategy. |

#### Scores Specification

When handling a `RECV_OTHER` event, the strategy must score the incoming block(s). The `scores` property of the return object should be an object where each key is a `blockId` and the value is a score entry object. You can use the existing `pool.scores` object for read-only reference.

*Example `scores` object:*
```json
"scores": {
    "12345677_P0": { /* ...score entry... */ },
    "12345678_P7": { /* ...score entry... */ }
  }
```

*Score Entry Object:*
| Property | Type | Description |
|---|---|---|
| `simClock` | float | A copy of `activeEvent.simClock`. Crucial for event ordering. |
| `localTime` | number | The pool's belief about unix NTP when it received the block header. |
| `diffScore` | BigInt | The raw block difficulty, potentially adjusted by a scoring mechanism. |
| `cumDiffScore` | BigInt | The cumulative difficulty score from the genesis block to this one. |
| `isHeadPath` | boolean | The pool's belief on whether this block is on the current chaintip path. |
| `chaintip` | string | The pool's belief about which blockId was the chaintip after processing the event. |

---

### Detailed Parameter Specifications

#### `activeEvent` Object

| Property | Type | Description |
|---|---|---|
| `simClock` | float | The global simulation timestamp for this event (high-precision float). |
| `poolId` | string | The ID of the pool processing the event. |
| `action` | string | The type of event: `'HASHER_FIND'` \| `'RECV_OWN'` \| `'RECV_OTHER'`. |
| `chaintip` | string \|null | `blockId` of the chaintip before processing the event. |
| `newIds` | array \|null | New `blockIds` that need to be processed by a pool. |

#### `pool` Object (Read-Only)

| Property | Type | Description |
|---|---|---|
| `id` | string | The pool's unique identifier (e.g., `P0`). |
| `strategy` | string | The strategy key from `strategy_manifest.json`. |
| `HPP` | number | Hash Power Percentage as a fraction (e.g., 0.31). |
| `hashrate` | number | The pool's absolute hashrate. |
| `ntpDrift` | number | A constant time offset (in seconds) applied at simulation start. |
| `chaintip` | string | The pool's current chaintip `blockId` *before* processing `activeEvent`. |
| `honTip` | string \| null | `blockId` that a *selfish miner* considers to be the public honest chaintip. |
| `requestIds` | Set() \| null | `blockIds` the pool has requested from the network, but not yet received. |
| `unscored` | Map(number, string)<br> \| null | `(height, blockId)` the pool has received, but can't yet score. |
| `config` | object | Pool agent specification loaded from `strategy_manifest.json` |

#### `blocks` Object (Read-Only)

This is a global dictionary of all blocks, keyed by `blockId`. Each entry is a block object:

| Property | Type | Description |
|---|---|---|
| `simClock` | number | Global simulation time when the block was created. |
| `height` | number | The block height. |
| `pool` | string | ID of the pool that mined the block. |
| `blockId` | string | Unique block identifier: `height_pool`. |
| `prevId` | string | The `blockId` of the parent block. |
| `timestamp` | number | The block's header timestamp (Unix seconds). |
| `difficulty` | BigInt | The difficulty target for this block. |
| `nxtDifficulty`| BigInt | The calculated difficulty for the *next* block in this chain. |
| `cumDifficulty`| BigInt | The cumulative difficulty up to and including this block. |
| `broadcast` | boolean | A flag indicating if the block has been broadcast. |
