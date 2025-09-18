
---

#### `config/README.md`

Do not modify the .example default files. Just run `npm start`, and they'll be copied automatically.
`default.env` is copied to the parent directory as: `.env`

---

## Configuration: Pools and Strategies

### `pools.json`
This file defines the mining pools participating in the simulation.

```json
{
  "P0": { "strategy": "HB0", "HPP": 0.40 },
  "P1": { "strategy": "HB0", "HPP": 0.37 }
  "P2": { "strategy": "SS0", "HPP": 0.23 }
}
```

*   **`P0`, `P1` `P2` ...:**  These are the unique pool identifiers.
*   **`strategy`:**  Key that links this pool to an entry in `strategy_manifest.json`.
*   **`HPP`:**  The Hash Power Percentage (as a fraction). The sum of all pools must equal 1

---

### `strategy_manifest.json`
This file maps a strategy key to a specific code module and entry function.

*Breakdown of a single strategy entry:*
```json
{
  "id": "HB0",
  "name": "Honest_Baseline",
  "description": "Monero's baseline existing PoW with no countermeasures.",
  "module": "./plugins/unified_pool_agent.js",
  "entryPoint": "executePoolAgent",
  "config": {
    "policy": { "honest": true, "k_Thresh": null, "retortPolicy": null },
    "scoringFunctions": {}
  }
}
```

*   **`id`**: The unique identifier for the strategy, referenced by `pools.json`.
*   **`name`**: A human-readable name for reference.
*   **`description`**: A reference description of the strategy's behavior.
*   **`module`**: Path to the file in `src/plugins/` which implements a pool agent (details below)
*   **`entryPoint`**: The exact name of the exported function to be called by the simulator.
*   **`config`**: A flexible JSON object passed directly to your strategy module. This allows you to parameterize your strategies with tuning constants, feature flags, or function lists without changing the core code.

---

### `src/plugins/unified_pool_agent.js`

This is the reference implementation - a complete pool agent capable of emulating a range of behaviors. With just a few knobs you can switch between:
*   **Baseline Honest Miner**: The basic Nakamoto Consensus (NC) strategy with no countermeasures.
*   **Selfish Pool**: A range of documented selfish strategies.
*   **Honest Countermeasures**: Selected difficulty-scoring countermeasures based on uncles, time, and depth penalties/bonuses.

> ***The scoringFunctions are highly extensible. Simply add a new function to `src/plugins/scoring_functions.js`, and enumerate it in `config.scoringFunctions` with any tuning parameters you wish to pass.
> For default NC behavior, keep an empty object `{}` like in the example above.***
