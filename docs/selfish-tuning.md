
---

## SELFISH STRATEGY TUNING

The `unified_pool_agent.js` module implements a powerful generalization for selfish miner behavior. This document explains the rationale and implementation.

---

### Introduction

A number of research papers model various selfish strategies. The presentation usually follows along one or more of: a state diagram, pseudo code, and/or a set of selfish actions and state transition triggers. While there is nuance to the topic which leads to a very large set of combinations of mixing-and-matching strategies that can be deployed at any particular set of state transitions ...

> **The majority of behaviors can be modeled with just two integer parameters: `k threshold` and `retort policy`.   

> Combined with `state` parameters, the behavior of selfish miners (SM) can be expressed in 3 simple policy equations.**

---

### Definitions

As an agent module in a state-stepping simulator, the pool agent must: *capture the pre-step state* -> *assess the activeEvent* -> *calculate outputs.* Thus, some of the parameter names below are slightly jarring from an academic perspective, but presented as code variables for clarity.

**Policy Parameters**
| Parameter | Definition | Effect |
|---|---|---|
| `kThresh` | The critical `k` value where SM decision logic activates:<br>&nbsp;&nbsp;**Claim victory when able** OR<br>&nbsp;&nbsp;**Abandon branch on `k-1`** | **`1`:** Classic Eyal-Sirer (always take the safe win)<br>**`0`:** Stubborn (embrace 0' risk before claiming)<br>**`-1`:** Very Stubborn (tolerate falling behind) |
| `retortPolicy` | Number of blocks to publish in response to a 1-block extension of the honest chain | **`0`:** Silent (publish nothing until reorg)<br>**`1`:** Contentious (fork every honest block)<br>**`2`:** Clobber (orphan every honest block) |

**State Parameters**
| Parameter | Definition |
|---|---|
| `commonAncestor` | `blockId` of the shared common ancestor between the honest and selfish branches |
| `ancestorHeight` | Block `height` of the `commonAncestor` |
| `selfLength` | Length of the secret selfish branch *before* integration of the activeEvent |
| `altLength` | Length of the honest branch *before* integration of the activeEvent |
| `addedLength` | Length added by the honest branch *after* integration of the activeEvent |
| `kNew` | Lead of the selfish pool over the honest network, *after* analyzing the event |
| `zeroPrimeBump` | An increment bias required to model the `0'` => `k+1` state transition:<br>&nbsp;&nbsp;&nbsp;`(altLength === selfLength) ? 2 : 1;` |

---

### Equations and Lookup Table

The selfish agent only cares about three things:
1. When to abandon their branch: `abandonThresh`
2. When to when to claim their branch: `claimThresh`
3. How many blocks to broadcast: `retortCount`

```
// Behavior is triggered when result > 0 //
abandonThresh = (altLength + addedLength) * (Math.min(0, kThresh) - kNew);
claimThresh   = (altLength + addedLength) * (Math.max(0, kThresh) - kNew + zeroPrimeBump);
retortCount   = Math.min(retortPolicy * addedLength, addedLength + 1);
```

The lookup tables below demonstrates the correctness of the equations. Note that this only applies when the honest branch has broadcast at least one block beyond the common ancestor. Otherwise that term just multiplies by zero (any scaling is merely incidental/irrelevant as the decision pivot is based on `result > 0`).

| kThresh | kNew | zeroPrimeBump | Abandon | Claim |
| :--- | :--- | :--- | :--- | :--- |
| 1 | -1 | 1 | 1 | 3 |
| 1 | 0 | 1 | 0 | 2 |
| 1 | 0’ => 1 | 2 | -1 | 2 |
| 1 | 2 => 1 | 1 | -1 | 1 |
| 1 | 2 | 1 | -2 | 0 |
| 1 | 3 | 1 | -3 | -1 |
| 0 | -1 | 1 | 1 | 2 |
| 0 | 0 | 1 | 0 | 1 |
| 0 | 0’ => 1 | 2 | -1 | 1 |
| 0 | 2 => 1 | 1 | -1 | 0 |
| 0 | 2 | 1 | -2 | -1 |
| -1 | -2 | 1 | 1 | 3 |
| -1 | -1 | 1 | 0 | 2 |
| -1 | 0 | 1 | -1 | 1 |
| -1 | 0’ => 1 | 2 | -2 | 1 |
| -1 | 2 => 1 | 1 | -2 | 0 |
| -1 | 2 | 1 | -3 | -1 |

| retortPolicy | addedLength | retortCount |
| :--- | :--- | :--- |
| 0 | 0 | 0 |
| 0 | 1 | 0 |
| 0 | 2 | 0 |
| 1 | 0 | 0 |
| 1 | 1 | 1 |
| 1 | 2 | 2 |
| 2 | 0 | 0 |
| 2 | 1 | 2 |
| 2 | 2 | 3 |
| 2 | 3 | 4 |

### Discussion

---

It could be argued there's a slight danger of clever code smell. However, concisely capturing a large range of selfish mining behaviors with just two user-facing knobs, far outweighs the dense switching logic required to implement an individual strategy, and verbosity to enumerate, document, and call them individually.

Hypothetically there's another knob we could add. Some strategies might decide to "*let it ride*" after transitioning from `0'` => `k+1`, and not "claim the win." They could do this an arbitrary number of times, limited only by chance. This possibility is documented in the "Stubborn Mining" paper, a variant they call "Equal-Fork stubborn." For conceptual simplicity it was excluded from the model, but would be trivial to add via the `zeroPrimeBump` variable.

**Tangential Commentary**

Much of the MDP literature focuses on a necessary simplification: `gamma` (the percent of honest hashpower that ends up mining the selfish branch). However, gamma is a direct consequence of network latency (and in some cases - eclipsing attacks).

A major benefit of a realistic network simulation is that we can dispense with `gamma` as a simplified aggregate, and rely on more granular heuristics via the stochastic ping modeling in the sim\_core.

---

### References

"Majority is not Enough: Bitcoin Mining is Vulnerable"  [the OG selfish mining]     
https://arxiv.org/pdf/1311.0243

"Stubborn Mining: Generalizing Selfish Mining"     
https://eprint.iacr.org/2015/796.pdf


