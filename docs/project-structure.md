
---

# Project Structure

High level overview of the environment and runtime.

---

## Directory Tree

**`.env`** - System, runtime, and high-level simulation parameters. Derived from *`config/default.env`*

**`config/`** - Granular control of pools, strategies, and historical data.   
&nbsp;&nbsp;&nbsp;&nbsp;**config/default.env** - Example *`.env`*. Basic - wont overload your system.   
&nbsp;&nbsp;&nbsp;&nbsp;**config/difficulty_bootstrap.csv** - Historical data for difficulty adjustment (*28 Feb 2025*)   
&nbsp;&nbsp;&nbsp;&nbsp;**config/pools.json** - Set the hashpower and strategy code for each pool   
&nbsp;&nbsp;&nbsp;&nbsp;**config/strategy_manifest.json** - Defines each unique strategy configuration   

**`data/`** - Simulation results, and the env details for run reproducibility

**`docs/`** - Project reference material and documentation  

**`logs/`** - Logging (see next section)   
&nbsp;&nbsp;&nbsp;&nbsp;**logs/info.log** - Intra-event operation details/flow.   
&nbsp;&nbsp;&nbsp;&nbsp;**logs/probe.log** - User-inlined `log2()` function for detailed probing.

**`src/`** - Simulation core     
&nbsp;&nbsp;&nbsp;&nbsp;**src/config_init.js** - If necessary, copies the sample env and config files   
&nbsp;&nbsp;&nbsp;&nbsp;**src/main.js** - Orchestrates simulation setup, parallel workers, and data output   
&nbsp;&nbsp;&nbsp;&nbsp;**src/sim_core.js** - Runs an isolated SIM\_ROUND. This is the event engine and blockchain physics   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;src/plugins/unified\_pool\_agent.js - The self-contained pool logic / strategy implementation   

---

## Runtime Commands
Command details and options are defined in *`package.json`*

**`npm start`:** Complete a full simulation run based on env and config. Delivers results to the `data/` directory.   

**`npm run log`:** Same as 'npm start', but log the primary operations internal to each sim-step event as they're queued up by the engine. Good for basic verification and isolating a failure location. Tagged inline via `log()` function. Output: *`logs/info.log`*.    

**`npm run log:probe`:**  A secondary log with no output other than what you explicitly inline into the code. Useful for generating verification checks data, pinpoint probing of sim/pool behaviors, and deep troubleshooting. Usage: Deploy inline `log2()` lines. Output: *`logs/probe.log`*.   

**`npm run lint`:**  A very basic eslint setup.   

> Recommend SIM\_ROUNDS=1 when running the log, as the files are overwritten each round.   
The functions `log()` and `log2()` can only be inlined inside *`sim_core.js`* and *`unified_pool_agent.js`*.

---

## *`.env`*
*`config/default.env`* is copied to the parent directory as *`.env`*. It contains crucial system, runtime, and high-level simulation parameters.

**SIM_DEPTH**    
&nbsp;&nbsp;&nbsp;&nbsp; - The number of hours to simulate in an isolated SIM\_ROUND.   
&nbsp;&nbsp;&nbsp;&nbsp;- All rounds are single-threaded.   
&nbsp;&nbsp;&nbsp;&nbsp;- Expect approximately 7 seconds for every 1000 sim-hours (including disk write time).   

**SIM_ROUNDS**    
&nbsp;&nbsp;&nbsp;&nbsp;- The number of unique simulations, each run to the specified SIM\_DEPTH.  
&nbsp;&nbsp;&nbsp;&nbsp;- Each round is isolated by *`main.js`*, and can be run in parallel.  
&nbsp;&nbsp;&nbsp;&nbsp;- This option will likely be deprecated once parameter sweeps are implemented.  

**WORKERS**    
&nbsp;&nbsp;&nbsp;&nbsp;- Maximum number of worker threads to launch in parallel (each round gets its own worker thread).  
&nbsp;&nbsp;&nbsp;&nbsp;- Roughly correlates with CPU threads. *`main.js`* manages the workers, your system manages CPU allocation.   

**MAX_RAM**    
&nbsp;&nbsp;&nbsp;&nbsp; - Total amount of system RAM, in megabytes, that may be consumed by *`main.js`* + all running workers.  
&nbsp;&nbsp;&nbsp;&nbsp; - Each worker consumes ~100MB for every 1000 sim-hours. Memory is freed as each worker completes its round.  

**DIFFICULTY_TARGET_V2**  
**DIFFICULTY_WINDOW**   
**DIFFICULTY_LAG**         
**DIFFICULTY_CUT**     
*See Monero's source code for more details. The sim difficulty adjustment was ported from `difficulty.cpp`.*  

**NETWORK_HASHRATE**     
&nbsp;&nbsp;&nbsp;&nbsp; - Total network hashes per second. Remains constant throughout the sim.   
&nbsp;&nbsp;&nbsp;&nbsp; - This must be aligned with *`config/difficulty.bootstrap.csv`* or it will cause inaccurate block times.   
&nbsp;&nbsp;&nbsp;&nbsp; - Per-pool absolute hashrate is derived from this and the hash power percentage in *`config/pools.json`*   

**BLOCK_SIZE**   
&nbsp;&nbsp;&nbsp;&nbsp;- Size of each block, in kilobytes. Remains constant throughout the sim.   
&nbsp;&nbsp;&nbsp;&nbsp;- Fluffy blocks are assumed, but certain conditions will cause a block propagation delay to activate.   

**SEED**   
&nbsp;&nbsp;&nbsp;&nbsp;- Randomness seed incremented each SIM\_ROUND, for fully reproducible runs.    
&nbsp;&nbsp;&nbsp;&nbsp;- Can be a number or a string, but it's converted to uint32 inside the sim\_core.  

**PING**   
&nbsp;&nbsp;&nbsp;&nbsp;- Average ping, in milliseconds, between pools (round trip time).    
&nbsp;&nbsp;&nbsp;&nbsp;- Ping between pools-and-hashers is assumed 2x longer than pool-pool (calculated inside *`sim_core.js`*).

**CV**   
&nbsp;&nbsp;&nbsp;&nbsp;- Coefficient of variance, as a single value for network variance in probability distribution calculations.   
&nbsp;&nbsp;&nbsp;&nbsp;- To simulate network degradation, here are some reference values:    
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **0.3** - Normal network   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **0.6** - Loaded network   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **1.2** - Minor degradation   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **2.0** - Medium degradation   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **3.0** - Heavy global disruption   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; **4.0+** - Borderline global outage   
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; *If you're simulating network degradation, remember to adjust ping higher as well.*  

**MBPS**   
&nbsp;&nbsp;&nbsp;&nbsp;- Pool-to-pool bandwidth, mega bits per second (Mbps).  

**NTP_STDEV**   
&nbsp;&nbsp;&nbsp;&nbsp;- Standard deviation, in seconds, of the NTP drift for each pool.    
&nbsp;&nbsp;&nbsp;&nbsp;- Average is assumed to be zero.    
&nbsp;&nbsp;&nbsp;&nbsp;- Derived once for each pool, and remains constant between each round.    

---

### See: *`docs/sim-core-internals.md`* for additional details on the network physics modeling.

---


