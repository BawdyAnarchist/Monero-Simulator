
---

### `src/README.md`

Do not modify the example/sample/default files. Copy them first (or just run the sim once and they'll be copied automatically. The `default.env` is copied to the parent directory as: `.env`

## Configuration: Pools and Strategies

---

### `pools.json`
This file defines the mining pools participating in the simulation.

```json
{
  "P0": { "strategy": "HB0", "HPP": 0.40 },
  "P1": { "strategy": "SR0", "HPP": 0.37 }
  "P2": { "strategy": "SR0", "HPP": 0.23 }
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
  "module": "./plugins/honest_scoring.js",
  "entryPoint": "invokeStrategyH",
  "config": { "scoringFunctions": [] }
}
```

*   **`id`**: The unique identifier for the strategy, referenced by `pools.json`.
*   **`name`**: A human-readable name for reference.
*   **`description`**: A reference description of the strategy's behavior.
*   **`module`**: The path to the JS file in `src/plugins/` that implements the strategy.
*   **`entryPoint`**: The exact name of the exported function to be called by the simulator.
*   **`config`**: A flexible JSON object passed directly to your strategy module. This allows you to parameterize your strategies with tuning constants, feature flags, or function lists without changing the core code.

> **Note on the Baseline Strategy**
> The `honest_scoring.js` module is written so that an empty `scoringFunctions` in the `config` object produces behavior identical to Monero's current consensus (no scoring adjustments).
