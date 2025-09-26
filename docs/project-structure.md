
---

# Project Structure

High level overview of the environment and runtime.

---

## Directory Tree

**Monero_sim/**  
├─ **.env** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *runtime parameters (derived from [default.env](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/config/default.env))*    
├─ **config/** &nbsp;&nbsp;&nbsp; # *Granular control of pools, strategies, and historical data*   
│&nbsp;&nbsp;&nbsp;├─ default.env &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *example .env -> copied on first run*   
│&nbsp;&nbsp;&nbsp;├─ difficulty_bootstrap.csv &nbsp; # *historical data for difficulty adjustment (28 Feb 2025)*   
│&nbsp;&nbsp;&nbsp;├─ pools.json &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# *set the hashpower and strategy code for each pool*   
│&nbsp;&nbsp;&nbsp;└─ strategy_manifest.json &nbsp; # *defines each unique strategy configuration*   
├─ **data/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *sim results*   
├─ **docs/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; #  *reference material*   
├─ **logs/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *see next section for logging details*   
│&nbsp;&nbsp;&nbsp;├─ info.log &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *Intra-event operation details/flow.*   
│&nbsp;&nbsp;&nbsp;└─ probe.log &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *user-inlined `probe()` function for detailed probing.*     
│     
└─ **src/** &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *sim core*     
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ config_init.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *if necessary, copies the sample env and config files*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ main.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;  # *orchestrates simulation setup, parallel workers, and data output*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├─ sim_core.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *runs an isolated SIM\_ROUND. This is the event engine and blockchain physics*   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└─ plugins/ &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *pluggable countermeasures/strategies*    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└─ unified\_pool\_agent.js &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; # *self-contained pool logic & strategy implementation*  

---

## Runtime Commands
Command details and options are defined in [package.json](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/package.json)    

**`npm start`:** Complete a full simulation run based on env and config. Delivers results to the [data](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/data) directory.    

**`npm run log`:** Same as 'npm start', but log the primary operations internal to each sim-step event as they're queued up by the engine. Good for basic verification and isolating a failure location. Tagged inline via `info()` function. Output: [logs/info.log](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/logs).

**`npm run log:probe`:**  A secondary log with no output other than what you explicitly inline into the code. Useful for generating verification checks data, pinpoint probing of sim/pool behaviors, and deep troubleshooting. Usage: Deploy inline `probe()` lines. Output: [logs/probe.log](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/logs).

**`npm run log:stats`:**  A log dedicated to auditing the outputs of the stochastic parameters as they're generated in real-time by the sim (latency, block find times, block transmission times). Usage: Output: [logs/stats.log](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/logs).

**`npm run lint`:**  A very basic eslint setup.

> Recommend SIM\_ROUNDS=1 when running the log, as the files are overwritten each round.   
The functions `info()` and `probe()` can only be inlined inside [sim_core.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/sim_core.js) and [unified_pool_agent.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/plugins/unified_pool_agent.js)   

---

## *`.env`*
[config/default.env](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/config/default.env) is copied to the parent directory as *`.env`*. It contains crucial system, runtime, and high-level simulation parameters.

**SIM_DEPTH**    
&nbsp;&nbsp;&nbsp;&nbsp; - The number of hours to simulate in an isolated SIM\_ROUND.   
&nbsp;&nbsp;&nbsp;&nbsp;- All rounds are single-threaded.   
&nbsp;&nbsp;&nbsp;&nbsp;- Expect approximately 7 seconds per 1000 simulated hours.

**SIM_ROUNDS**    
&nbsp;&nbsp;&nbsp;&nbsp;- The number of unique simulations, each run to the specified SIM\_DEPTH.  
&nbsp;&nbsp;&nbsp;&nbsp;- Each round is isolated by [main.js](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/src), and can be run in parallel.  
&nbsp;&nbsp;&nbsp;&nbsp;- This option will likely be deprecated once parameter sweeps are implemented.  

**WORKERS**    
&nbsp;&nbsp;&nbsp;&nbsp;- Maximum number of worker threads to launch in parallel (each round gets its own worker thread).  
&nbsp;&nbsp;&nbsp;&nbsp;- Roughly correlates with CPU threads. [main.js](https://github.com/BawdyAnarchist/Monero-Simulator/tree/main/src) manages the workers, your system manages CPU allocation.   

**WORKER_RAM**    
&nbsp;&nbsp;&nbsp;&nbsp; - Max RAM, in megabytes, that a single worker may use.
&nbsp;&nbsp;&nbsp;&nbsp; - A worker consumes ~1024 MB at SIM\_DEPTH=7000. Memory is freed after worker completion.   
&nbsp;&nbsp;&nbsp;&nbsp; - Recommend leaving at 2048 MB. Too low will trigger OOM (heap exhaustion) and terminate the worker.    

**DIFFICULTY_TARGET_V2**  
**DIFFICULTY_WINDOW**   
**DIFFICULTY_LAG**         
**DIFFICULTY_CUT**     
*See Monero's source code for more details. The sim difficulty adjustment was ported from [difficulty.cpp](https://github.com/monero-project/monero/blob/master/src/cryptonote_basic/difficulty.cpp)*   

**NETWORK_HASHRATE**     
&nbsp;&nbsp;&nbsp;&nbsp; - Total network hashes per second. Remains constant throughout the sim.   
&nbsp;&nbsp;&nbsp;&nbsp; - This must be aligned with [difficulty.bootstrap.csv](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/config/difficulty_bootstrap.csv.sample) or it will cause inaccurate block times.   
&nbsp;&nbsp;&nbsp;&nbsp; - Per-pool absolute hashrate is derived from this and the hash power percentage in [pools.json](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/config/pools.json.example)    

**BLOCK_SIZE**   
&nbsp;&nbsp;&nbsp;&nbsp;- Size of each block, in kilobytes. Remains constant throughout the sim.   
&nbsp;&nbsp;&nbsp;&nbsp;- Fluffy blocks are assumed, but certain conditions will cause a block propagation delay to activate.   

**SEED**   
&nbsp;&nbsp;&nbsp;&nbsp;- Randomness seed incremented each SIM\_ROUND, for fully reproducible runs.    
&nbsp;&nbsp;&nbsp;&nbsp;- Can be a number or a string, but it's converted to uint32 inside [sim_core.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/sim_core.js)    

**PING**   
&nbsp;&nbsp;&nbsp;&nbsp;- Average ping, in milliseconds, between pools (round trip time).    
&nbsp;&nbsp;&nbsp;&nbsp;- Ping between pools-and-hashers is assumed 2x longer than pool-pool (calculated inside [sim_core.js](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/src/sim_core.js))    
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

### See: [docs/sim-core-internals.md](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/docs/sim-core-internals.md) for additional details on the network physics modeling.
---


