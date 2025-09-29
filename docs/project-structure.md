
---

# Project Structure

High level overview of the environment and runtime.

---

## Directory Tree

**Monero_sim/**  
├─ **.env** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *runtime parameters (derived from [env.example](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/defaults/env.example))*    
├─ **config/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Granular control of pools, strategies, and historical data*   
│&nbsp;&nbsp;&nbsp;├─ difficulty.json &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Diffculty algorithm parameters*    
│&nbsp;&nbsp;&nbsp;├─ difficulty_bootstrap.csv &nbsp; # *historical data for difficulty adjustment (28 Feb 2025)*   
│&nbsp;&nbsp;&nbsp;├─ dynamic_blocks.json &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Just BLOCK_SIZE (for now). Required for network realism*   
│&nbsp;&nbsp;&nbsp;├─ internet.json &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Network latency realism parameters (ping)*    
│&nbsp;&nbsp;&nbsp;├─ pools.json &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# *set the hashpower and strategy code for each pool*   
│&nbsp;&nbsp;&nbsp;└─ strategy_manifest.json &nbsp; # *defines each unique strategy configuration*   
├─ **data/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *sim results*   
├─ **defaults/** &nbsp;&nbsp; # *Granular control of pools, strategies, and historical data*   
│&nbsp;&nbsp;&nbsp;├─ env.example &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *example .env -> copied on first run*   
│&nbsp;&nbsp;&nbsp;└─ *[ ..other example files.. ]*   
├─ **docs/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; #  *reference material*   
├─ **logs/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *see next section for logging details*   
│&nbsp;&nbsp;&nbsp;├─ info.log &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Intra-event operation details/flow.*   
│&nbsp;&nbsp;&nbsp;└─ probe.log &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *user-inlined `probe()` function for detailed probing.*     
└─ **src/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *sim core*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ config_init.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Ingests the tunable config and passes it to main*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ main.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;  # *Initializes shared state, manages parallel workers, and handles data streams*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ round_orchestrator.js &nbsp;&nbsp;&nbsp;&nbsp; # *Setup, housekeeping, analysis, data formatting for the engine*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ sim_engine.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Core blockchain physics and event processing engine*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└─ plugins/ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *pluggable countermeasures/strategies*    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└─ unified\_pool\_agent.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *self-contained pool logic & strategy implementation*     

---

## Runtime Commands
Command options are defined in [package.json](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/package.json)
| CLI | Description |
| --- | --- |
| **`npm start`** | Run simulation based solely on the saved env and config.   
| **`npm run sim:simple`** | One line aggregated chain health metrics per round (no scores/blocks).  
| **`npm run sim:full`** | Full data generation with all blocks and per-pool scores/metrics.    
| **`npm run sim:sweep`** | Apply sweeps configuration. Simple output per sweep/round.
| **`npm run log`** | Full data generation, plus the info log.    
| **`npm run log:probe`**  | Full data, info.log, and probe.log.    
| **`npm run log:stats`**  | Full data, info.log, and stats.log.     
| **`npm run lint`**  | A very basic eslint setup.

*When running the log, recommend SIM\_DEPTH < 1000 to limit heap and filesize growth.*   

Results (data) saved at: [data](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/data)   
Logs saved at: [data](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/logs)   

---

## *`.env`*
[defaults/env.example](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/defaults/env.example) is copied to the parent directory as *`.env`*. It contains crucial system, runtime, and high-level simulation parameters.

**SIM_DEPTH**    
&nbsp;&nbsp;&nbsp;&nbsp;- The number of hours to simulate in an isolated SIM\_ROUND.   
&nbsp;&nbsp;&nbsp;&nbsp;- All rounds are single-threaded.   
&nbsp;&nbsp;&nbsp;&nbsp;- Approximately: 4 sec / 1000 sim-hours (summary only); 7 sec / 1000 sim-hours (full data output).

**SIM_ROUNDS**    
&nbsp;&nbsp;&nbsp;&nbsp;- Two modes: [integer|sweep].    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;-- [integer]: The number of unique simulations, each run to the specified SIM\_DEPTH.  
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;-- [sweep]: The required number of rounds are calculated based on the full combinations of the sweeps config.   
&nbsp;&nbsp;&nbsp;&nbsp;- Each round is isolated by [main.js](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/src), and can be run in parallel.  

**WORKERS**    
&nbsp;&nbsp;&nbsp;&nbsp;- Maximum number of worker threads to launch in parallel (each round gets its own worker thread).  
&nbsp;&nbsp;&nbsp;&nbsp;- Roughly correlates with CPU threads. [main.js](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/src) manages the workers, your system manages CPU allocation.   

**WORKER_RAM**    
&nbsp;&nbsp;&nbsp;&nbsp;- Max RAM, in megabytes, that a single worker may use.    
&nbsp;&nbsp;&nbsp;&nbsp;- A worker consumes ~1024 MB at SIM\_DEPTH=7000. Memory is freed after worker completion.   
&nbsp;&nbsp;&nbsp;&nbsp;- Recommend leaving at 2048 MB. Too low will trigger OOM (heap exhaustion) and terminate the worker.    

**DATA_MODE**    
&nbsp;&nbsp;&nbsp;&nbsp;- 3 modes: [simple|metrics|full]. The amount/type of data output to [data/](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/data).   
&nbsp;&nbsp;&nbsp;&nbsp;- simple: provides one line of aggregated chain health metrics per round, but no scores or blocks.   
&nbsp;&nbsp;&nbsp;&nbsp;- metrics: per-pool chain health metrics per round, but no per-pool scores, and no blocks.   
&nbsp;&nbsp;&nbsp;&nbsp;- full: output all blocks, per-pool scores, per-pool metrics. Consumes ~11 MB disk space per 1000 sim-hours.  

**LOG_MODE**    
&nbsp;&nbsp;&nbsp;&nbsp;- info,probe,stats (or any combination, or leave empty for no log). Output: [logs/info.log](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/logs).   
&nbsp;&nbsp;&nbsp;&nbsp;- info: Basic inspection of operations internal to each sim-step. Pre-tagged inline via `info()` function.    
&nbsp;&nbsp;&nbsp;&nbsp;- probe: Secondary isolated log for pinpoint behavior probing. Empty unless you inline the `probe()` function.     
&nbsp;&nbsp;&nbsp;&nbsp;- stats: Audit the stochastic parameters as they're generated in real-time for sim events.  
&nbsp;&nbsp;&nbsp;&nbsp;- Recommend SIM\_ROUNDS=1 when running the log, as the files are overwritten each round.   
&nbsp;&nbsp;&nbsp;&nbsp;- `info()` and `probe()` can only be inlined inside [round_orchestrator.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/round_orchestrator.js), [sim_engine.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/sim_engine.js), and [unified_pool_agent.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/plugins/unified_pool_agent.js)    
&nbsp;&nbsp;&nbsp;&nbsp;- *WARNING: High SIM_DEPTH values (>1000) can create large logs, and consume significantly more RAM (heap)*    
   
**SEED**   
&nbsp;&nbsp;&nbsp;&nbsp;- Randomness seed incremented each SIM\_ROUND, for fully reproducible runs.    
&nbsp;&nbsp;&nbsp;&nbsp;- Can be a number or a string, but ultimately it gets cast as uint32.   

## *`config/difficulty.json`*

**DIFFICULTY_TARGET_V2**  
**DIFFICULTY_WINDOW**   
**DIFFICULTY_LAG**         
**DIFFICULTY_CUT**     
*See Monero's source code for more details. The sim difficulty adjustment was ported from [difficulty.cpp](https://github.com/monero-project/monero/blob/master/src/cryptonote_basic/difficulty.cpp)*   

## *`config/dynamic_blocks.json`*

**BLOCK_SIZE**   
&nbsp;&nbsp;&nbsp;&nbsp;- Size of each block, in kilobytes. Remains constant throughout the sim.   
&nbsp;&nbsp;&nbsp;&nbsp;- Fluffy blocks are assumed, but certain conditions will cause a block propagation delay to activate.   

## *`config/internet.json`*

**NETWORK_HASHRATE**     
&nbsp;&nbsp;&nbsp;&nbsp; - Total network hashes per second. Remains constant throughout the sim.   
&nbsp;&nbsp;&nbsp;&nbsp; - This must be aligned with [difficulty.bootstrap.csv](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/config/difficulty_bootstrap.csv.sample) or it will cause inaccurate block times.   
&nbsp;&nbsp;&nbsp;&nbsp; - Per-pool absolute hashrate is derived from this and the hash power percentage in [pools.json](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/config/pools.json.example)    

**PING**   
&nbsp;&nbsp;&nbsp;&nbsp;- Average ping, in milliseconds, between pools (round trip time).    
&nbsp;&nbsp;&nbsp;&nbsp;- Ping between pools-and-hashers is assumed 2x longer than pool-pool (calculated inside [round_orchestrator.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/round_orchestrator.js))    
&nbsp;&nbsp;&nbsp;&nbsp;- To simulate network degradation, here are some reference values:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **70** - normal network   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **150** - loaded network   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **500** - minor degradation   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **1000** - medium degradation   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **3000** - large disruption   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **9000** - heavy global disruption   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **15000** - effective outage   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; *If you're simulating network degradation, remember to adjust MBPS lower.*  

**CV**   
&nbsp;&nbsp;&nbsp;&nbsp;- Coefficient of variance, as a single value for network variance in probability distribution calculations.   
&nbsp;&nbsp;&nbsp;&nbsp;- Don't change this unless you really know what you're doing. Use ping for simulated network degradation.

**MBPS**   
&nbsp;&nbsp;&nbsp;&nbsp;- Pool-to-pool bandwidth, mega bits per second (Mbps).  

**NTP_STDEV**   
&nbsp;&nbsp;&nbsp;&nbsp;- Standard deviation, in seconds, of the NTP drift for each pool.    
&nbsp;&nbsp;&nbsp;&nbsp;- Average is assumed to be zero.    
&nbsp;&nbsp;&nbsp;&nbsp;- Derived once for each pool, and remains constant between each round.    

---

### See: [docs/sim-physics.md](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/docs/sim-engine-internals.md) for additional details on the network physics modeling.
---


