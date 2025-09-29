# WIP, mostly scratch space for now
---

### `src/plugins/unified_pool_agent.js`

This is the reference implementation - a complete pool agent capable of emulating a range of behaviors. With just a fe   w knobs you can switch between:
*   **Baseline Honest Miner**: The basic Nakamoto Consensus (NC) strategy with no countermeasures.
*   **Selfish Pool**: A range of documented selfish strategies.
*   **Honest Countermeasures**: Selected difficulty-scoring countermeasures based on uncles, time, and depth penalties   /bonuses.

> ***The scoringFunctions are highly extensible. Simply add a new function to `src/plugins/scoring_functions.js`, and    enumerate it in `config.scoringFunctions` with any tuning parameters you wish to pass.   
> For default NC behavior, keep an empty object `{}` like in the example above.***

