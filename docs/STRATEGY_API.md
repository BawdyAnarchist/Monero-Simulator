
---

### `src/plugins/README.md`

## Strategy Plugin API Reference

Strategy modules define a pool's behavior in response to network events. The simulation core (`sim_core.js`) calls the registered `entryPoint` function for a strategy, passing it the current state. The strategy must then return an object instructing the core on how to proceed.

### Function Signature

A strategy's entry point must conform to the following signature:
```javascript
function invokeStrategy(activeEvent, pool, blocks) {
  // ... strategy logic ...
  return { chaintip, timestamp, scores, broadcastId };
}
```

---

### Parameters (Inputs)

The entry point receives three objects as arguments:

| Parameter | Description |
|---|---|
| `activeEvent` | An object containing details of the event this pool must process. |
| `pool` | A read-only object representing the current state of the pool. |
| `blocks` | A read-only object containing the full state of all known blocks. |

> **IMPORTANT: State Immutability**
> The `pool` and `blocks` objects are direct references to the global simulation state. **Do not mutate them directly.** Modifying these objects will corrupt the simulation state and produce invalid results. All state changes must be communicated through the `return` object.

---

### Return Value (Outputs)

The strategy function **MUST** return an object with the following properties.

| Property | Type | Description |
|---|---|---|
| `chaintip` | string | The `blockId` of the block the pool considers its new chain tip after processing the event. |
| `timestamp` | number \| null | **On `CREATE`:** The Unix timestamp for the new block. A strategy can manipulate this. <br> **On `RECV`:** Must be `null`, as the received block already has a timestamp. |
| `scores` | object \| null | **On `CREATE`:** Must be `null`. The new block's score is handled by the sim core. <br> **On `RECV`:** An object containing score entries for any newly received blocks. See `Scores Specification` below. |
| `broadcastId` | string \| null | The `blockId` of a block to broadcast. If the strategy decides not to broadcast, this must be `null`. |

#### Scores Specification

When handling a `RECV` event, the strategy must score the incoming block(s). The `scores` property of the return object should be an object where each key is a `blockId` and the value is a score entry object. You can use the existing `pool.scores` object for read-only reference.

*Example `scores` object:*
```json
{
  "scores": {
    "12345677_P0": { /* ...score entry... */ },
    "12345678_P7": { /* ...score entry... */ }
  }
}
```

*Score Entry Object:*
| Property | Type | Description |
|---|---|---|
| `localTime` | number | The pool's `simClock` time when it processed the block (rounded Unix seconds). |
| `diffScore` | BigInt | The raw block difficulty, potentially adjusted by a scoring mechanism. |
| `cumDiffScore` | BigInt | The cumulative difficulty score from the genesis block to this one. |
| `isHeaviest` | boolean | The pool's belief on whether this block is on the heaviest chain. |

---

### Detailed Parameter Specifications

#### `activeEvent` Object

| Property | Type | Description |
|---|---|---|
| `simClock` | number | The global simulation timestamp for this event (high-precision float). |
| `poolId` | string | The ID of the pool processing the event. |
| `action` | string | The type of event: `'CREATE_BLOCK'` or `'RECV_BLOCK'`. |
| `chaintip` | string | The `blockId` that the new block (`newTip`) is extending. |
| `newTip` | string | The `blockId` of the block that was just created or received. |

#### `pool` Object (Read-Only)

| Property | Type | Description |
|---|---|---|
| `id` | string | The pool's unique identifier (e.g., `P0`). |
| `strategy` | string | The strategy key from `strategy_manifest.json`. |
| `HPP` | number | Hash Power Percentage as a fraction (e.g., 0.31). |
| `hashrate` | number | The pool's absolute hashrate. |
| `ntpDrift` | number | A constant time offset (in seconds) applied at simulation start. |
| `chaintip` | string | The pool's current chaintip `blockId` *before* processing `activeEvent`. |
| `scores` | object | A dictionary of all previously scored blocks, keyed by `blockId`. |

#### `blocks` Object (Read-Only)

This is a global dictionary of all blocks, keyed by `blockId`. Each entry is a block object:

| Property | Type | Description |
|---|---|---|
| `simClock` | number | The global simulation time when the block was created. |
| `height` | number | The block height. |
| `pool` | string | The ID of the pool that mined the block. |
| `blockId` | string | Unique block identifier: `height_pool`. |
| `prevId` | string | The `blockId` of the parent block. |
| `timestamp` | number | The block's header timestamp (Unix seconds). |
| `difficulty` | BigInt | The difficulty target for this block. |
| `nxtDifficulty`| BigInt | The calculated difficulty for the *next* block in this chain. |
| `cumDifficulty`| BigInt | The cumulative difficulty up to and including this block. |
| `broadcast` | boolean | A flag indicating if the block has been broadcast. |
