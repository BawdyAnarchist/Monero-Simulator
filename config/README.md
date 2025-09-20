
---

## Pools and Strategies Quick Reference

**Do not modify the .example default files. Just run `npm start`, and they'll be copied automatically.**

---

### *`pools.json`*
Configures the mining pools participating in the simulation.

```json
{
  "P0": { "strategy": "HB0", "HPP": 0.40 },
  "P1": { "strategy": "HB0", "HPP": 0.37 }
  "P2": { "strategy": "SS0", "HPP": 0.23 }
  ...
}
```

*   **`P0`, `P1` `P2` ...**  These are the unique pool identifiers.
*   **`strategy`:**  Unique key that links a pool to an entry in *`strategy_manifest.json`*.
*   **`HPP`:**  The hash power percentage (as a fraction). The sum of all pools must equal **1**

---

### *`strategy_manifest.json`*
Defines strategy configurations, along with a unique key for use with *`pools.json`*. Sim pools are agentic -- they must independently determine what actions to take given the network information they have. The reference implementation (*`unified_pool_agent.js`*) allows behavior tuning with simple config knobs passed via this json file.

*Breakdown of a single strategy entry:*
```json
{
  "id": "HB0",
  "name": "Honest_Baseline",
  "description": "Monero's baseline existing PoW with no countermeasures.",
  "module": "./plugins/unified_pool_agent.js",
  "entryPoint": "invokePoolAgent",
  "config": {
    "policy": { "honest": true, "kThresh": null, "retortPolicy": null },
    "scoringFunctions": {}
  }
}
```

*   **`id`**: The unique identifier for the strategy, referenced by *`pools.json`*.
*   **`name`**: A human-readable name for reference.
*   **`description`**: A reference description of the strategy's behavior.
*   **`module`**: Path to the file in *`src/plugins/`* which implements a pool agent (details below)
*   **`entryPoint`**: The exact name of the exported function to be called by the simulator.
*   **`config`**: A flexible JSON object passed directly to your strategy module. This allows you to parameterize your strategies with tuning constants, feature flags, or function lists without changing the core code.

---
