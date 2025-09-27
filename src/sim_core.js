/////////////////////////////////
//     SIMULATION   CORE       //
/////////////////////////////////

// -----------------------------------------------------------------------------
// SECTION 1: IMPORTS, CONSTANTS, GLOBAL STATE
// -----------------------------------------------------------------------------

import path from 'path';
import { parentPort, workerData } from 'node:worker_threads';
import v8 from 'v8';
import { gzipSync } from 'node:zlib';
import TinyQueue from 'tinyqueue';
import { randomLcg, randomLogNormal, randomExponential } from 'd3-random';

/* Data passed by the worker manager in main. They become global pointers (can still mutate them) */ 
const { idx, CONFIG, state } = workerData;
const { sim, parsed, log } = CONFIG;
const { pools, blocks, startTip, diffWindows } = state;

/* Critical simulation parameters */
const rng        = randomLcg((sim.seed + idx) >>> 0);
let   simNoise   = {};
let   has_exited = false;

const LOG = { info:  [], probe: [], stats: [] };
const info  = (msg) => { if (!log.info)  return; LOG.info.push(msg()); }
const probe = (msg) => { if (!log.probe) return; LOG.probe.push(msg()); }
const stats = (msg) => { if (!log.stats) return; LOG.stats.push(msg()); }


// -----------------------------------------------------------------------------
// SECTION 2: ONE TIME INITIALIZATION FUNCTIONS
// -----------------------------------------------------------------------------

function makeNoiseFunctions() {
/*
   Prepare random distribution functions and their constants once, in advance. We model 2
   distinct network profiles. Hasher<-->Pool is assumed to be about 2x worse than pool<-->pool.
   Even under normal network, tail-end ping-time spikes are common. They're part of the model.
*/
   /* Ping was used in .env for familiarity, but sim uses one-way-delay (owd) */
   const ping    = sim.ping / 1e3;                            // ms -> sec (sim consistency)
   const CV      = sim.cv;
   const sigma   = Math.sqrt(Math.log(1 + CV*CV));            // pool-to-pool (P2P)
   const pingMu  = Math.log(ping) - 0.5 * sigma * sigma;      // One-way latency
   const sigma2  = Math.sqrt(Math.log(1 + CV*CV));            // Pool-to-hasher (P2H) penalty
   const pingMu2 = Math.log(ping*2) - 0.5 * sigma2 * sigma2;  // One-way latency
   const txTime  = sim.blockSize / (sim.mbps * 1024 / 8)      // Block tx time. Mbps -> KB/sec
   const txMu    = Math.log(txTime) - 0.5 * sigma * sigma;

   /* Ping spike model. Rare/random delays, scale up by ping to mimic network degradation */
   const spikeProb = (base_pct) => base_pct-0.01 + (1-base_pct) * (ping/(ping + 5)); // Magic (s-curve)
   const spikeMult = () => 1 + Math.pow(1 + ping, 0.7);                              // Magic

   /* Seed generators once. Declare samplers (prob distributions) to call later (most efficient) */
   const logNormal   = randomLogNormal.source(rng);
   const exponential = randomExponential.source(rng);
   const baseP2P     = logNormal(pingMu,  sigma);
   const baseP2H     = logNormal(pingMu2, sigma2);
   const baseTxTime  = logNormal(txMu, sigma);

   /* Call the samplers, with the stats() log integrated for correctness auditing */
   const owdP2P = () => {                        // 1% prob of 2x spike at 50ms P2P
      const value = rng() < spikeProb(0.01) ? baseP2P() * spikeMult() : baseP2P();
      stats(() => `owdP2P: ${value}`);
      return value;
   };
   const owdP2H = () => {                        // 4% prob of 2x spike at 50ms P2P
      const value = rng() < spikeProb(0.04) ? baseP2H() * spikeMult() : baseP2H();
      stats(() => `owdP2H: ${value}`);
      return value;
   };
   const transTime = () => {
      const value = baseTxTime();
      stats(() => `transTime: ${value}`);
      return value;
   };
   const blockTime = (lambda) => {
      const value = exponential(lambda)();
      stats(() => `BlockTime_λ: ${value} ${lambda}`);
      return value;
   };

   return {
      owdP2P:    owdP2P,                        // One-Way-Delay, Pool-to-Pool
      owdP2H:    owdP2H,                        // One-Way-Delay, Pool-to-Hasher
      transTime: transTime,                     // Time to send block, not including OWD
      blockTime: blockTime,                     // Per-pool expected blockTime
   }
}

async function makeStrategiesFunctions() {
/*
   Import modules, then set entryPoints functions in the strategies object. Ideally this would
   be in main.js, but worker threads can't pass functions. Must build it here, inside the worker.
 */
   let strategies = Object.create(null);
   for (const strategy of parsed.manifest) {
      const module = await import(path.resolve(CONFIG.root, 'src', strategy.module));
      if (typeof module.setLog  === 'function') module.setLog(info);      // Inject into pool agent
      if (typeof module.setLog2 === 'function') module.setLog2(probe); // Inject into pool agent
      const entryPoint = strategy.entryPoint;
      strategies[strategy.id] = module[entryPoint];  // Populate strategies with id and function
   }
   return strategies;
}


// -----------------------------------------------------------------------------
// SECTION 3: HELPERS AND HOUSEKEEPING
// -----------------------------------------------------------------------------

function timeNow() {
   return new Date().toLocaleTimeString();
}
function msNow() {
   return new Date().toISOString().slice(11, 23);
}

function reconstructDiffWindow(blockId) {
   info(() => `reconstructDiffWindow: diffWindow missing for ${blockId}. Reconstructing it ...`);
   const diffWindow  = [];
   let loopId = blockId;
   for (let i = 0; i < (sim.diffWindow + sim.diffLag) && loopId; i++) {
      const b = blocks[loopId];
      diffWindow.push({ timestamp: b.timestamp, cumDifficulty: b.cumDifficulty, });
      loopId = b.prevId;
   }
   diffWindow.reverse();
   diffWindows[blockId] = diffWindow;
}

function resourceManagement(eventQueue) {
   /* Prune unused diffWindows to keep memory usage down */
   const keepWindows = new Set();
   for (const p of Object.values(pools)) {
      keepWindows.add(p.chaintip);
      const prev = blocks[p.chaintip]?.prevId;
      if (prev) keepWindows.add(prev);
   }
   for (const k in diffWindows) if (!keepWindows.has(k)) delete diffWindows[k];

   /* Prevent popped events from lingering and consuming memory */
   if (eventQueue.data.length > eventQueue.length * 3) eventQueue.data.length = eventQueue.length;
}

function calculateMetrics(results) {
/*
   Summarize important metrics for the round. Orphan rate, reorg length stats, and selfish miner
   advantage. Pool selection bias is avoided by analyzing the perspective of all pools, then avg/
   stdev over all pools to present aggregated results. Stdev helps identify pool-view divergences.
*/
   let selfishHPP   = 0;
   let selfishIds   = new Set();
   let honestIds    = new Set();
   let ancestor     = Object.values(pools)[0].chaintip;   // Order doesnt matter, any pool will do

   /* Walkback over every single pool, until all agree that the score is on a shared headPath */
   for (const p of Object.values(pools)) {
      if (p.config.policy?.honest) {
         honestIds.add(p.id);
      } else {
         selfishIds.add(p.id);
         selfishHPP += p.HPP
      }
   }

   /* Loop over all the pools, aggregating their unique metrics view of the network */
   const metrics = new Object();
   for (const p of Object.values(pools)) {
      if (selfishIds.has(p.id)) continue;                     // Only care about honest pool view

      /* Critical variables required for per-pool metrics calculations */
      let prevTip      = startTip;
      let orphanCount  = 0;
      let reorgList    = [];
      let reorgDepth   = 0;
      let selfishCount = 0;
      let totalCount   = 0;

      /* Reorgs detection. Reorgs arent merely the orphan count, but an actual head switch */
      const scores = Object.entries(p.scores);                // Copy the pool's scores object
      for (const [id, score] of scores) {
         if (score.isHeadPath) {
            if (selfishIds.has(blocks[id].poolId)) selfishCount++;
            if (reorgDepth > 0) {           // Reorg depth > 0 only when prevTip was not headPath
               reorgList.push(reorgDepth);  // Track all unique, completed reorg lengths
               reorgDepth = 0;
            }
         } else {
            /* Non-selfish blocks not in the head path, and not mere latency artifacts (orphans) */
            if (selfishIds.has(blocks[id].poolId)) continue;
            orphanCount++;
            if (blocks[id].height !== blocks[prevTip].height) reorgDepth++;
         }
         totalCount++;
         prevTip = id;
      }

      /* Nothing to report. Guard against zeros / divide by zero */
      if (totalCount === 0 || reorgList.length === 0) {
         metrics[p.id] = { orphanRate: 0, reorgP99: 0, reorgMax: 0, selfProfit: 0};
         continue;
      }
      /* Calculate metrics for the pool and add to the metrics object */
      reorgList.sort((a, b) => a - b);
      const orphanRate   = orphanCount / (totalCount - 1);       // (-1) because HH0 is the startTip
      const reorgMax     = reorgList.at(-1);
      const reorgP99     = reorgList[Math.ceil(reorgList.length * 0.99) - 1];
      const selfProfit   = (selfishCount / (totalCount - 1)) - selfishHPP;
      metrics[p.id] = {
         orphanRate: orphanRate,
         reorgMax:   reorgMax,
         reorgP99:   reorgP99,
         selfProfit: selfProfit,
      }
   }
   /* Summarize the metrics from all the pools. Include stdev to detect partitioning or divergence */
   const keys = Object.keys(Object.values(metrics)[0]);
   const summary = {};
   keys.forEach(key => {
     const values = Object.values(metrics).map(m => m[key]);
     const mean = values.reduce((a, b) => a + b, 0) / values.length;
     const stdev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
     summary[key] = { mean, stdev };
   });
   results.metrics = metrics;
   results.summary = summary;
}

function prepareDataExport(results) {
/* Final data formatting applied here to keep load off of main.js for parallelizable tasks. */

   results.headers = {};   // Storage object to write the headers later

   /* Summarized metrics*/
   const summaryKeys   = Object.keys(results.summary);
   const summaryValues = summaryKeys.flatMap(key => [
      results.summary[key].mean.toFixed(4),
      results.summary[key].stdev.toFixed(4),
   ]);
   results.summary = [idx, ...summaryValues].join(',') + '\n';
   results.headers['summary'] = ['round', ...summaryKeys.flatMap(k => [k, `${k}_Std`])].join(',');

   /* Metrics per pool */
   const metricFields  = Object.keys(Object.values(results.metrics)[0]);
   const metricsResult = Object.values(pools)
      .filter(p => results.metrics[p.id])
      .map(p => [idx, p.id, ...metricFields.map(k =>
         results.metrics[p.id][k].toFixed(4))].join(','))
      .join('\n') + '\n';
   results.metrics = metricsResult;
   results.headers['metrics'] = ['idx', 'poolId', ...metricFields].join(',');

   /* Pool scores */
   const scoreFields   = Object.keys(pools[Object.keys(pools)[0]].scores[startTip]);
   const scoresResults = Object.values(pools).flatMap(p => {
      const scores = Object.entries(p.scores);
      return scores.map(([blockId, score]) =>                  // Formatting
         [idx, p.id, blockId, ...scoreFields.map(k => k === 'simClock'
            ? score[k].toFixed(7) : score[k])].join(',')
      );
   });
   results.scores = gzipSync(Buffer.from(scoresResults.join('\n') + '\n'));
   results.headers['scores'] = ['idx', 'poolId', 'blockId', ...scoreFields].join(',');

   /* Blocks */
   const blockFields   = Object.keys(blocks[startTip]);
   const blocksResults = Object.values(blocks)
      .filter(b => b.height > blocks[startTip].height)            // Filter out historical blocks
      .map(b => [idx, ...blockFields.map(k => b[k])].join(','))
      .join('\n') + '\n';
   results.blocks = gzipSync(Buffer.from(blocksResults));
   results.headers['blocks'] = ['idx', ...blockFields].join(',');

   /* Format the log buffers */
   LOG.info  = LOG.info.join('\n');
   LOG.probe = LOG.probe.join('\n');
   LOG.stats = LOG.stats.join('\n');
}

function exitSimWorker(exit_code, results) {
/* Unified exit and message handling, both success and error */

   if (has_exited) return;   // Prevent any possibility of a double-call (unlikely but defended)
   has_exited = true;

   if (exit_code === 0) {
      const { used_heap_size } = v8.getHeapStatistics();             // Heap RAM usage
      console.log(`[${timeNow()}] Round ${idx.toString().padStart(3, '0')} ` +
         `completed with heap size: ${(used_heap_size/1_048_576).toFixed(1)} MB`);
   }
   parentPort.postMessage(
      { results: results, log: LOG },
      [ results.blocks.buffer, results.scores.buffer ]
   );

   setImmediate(() => process.exit(exit_code));
}


// -----------------------------------------------------------------------------
// SECTION 4: CORE BLOCKCHAIN LOGIC
// -----------------------------------------------------------------------------

function simulateBlockTime(eventQueue, p, simClock) {
/* Simulated a new blockTime, whenever a pool changes chaintip.  */

   const nxtDifficulty = blocks[p.chaintip].nxtDifficulty;
   const lambda        = p.hashrate / Number(nxtDifficulty);  // Downgrade from BigInt
   const timeToFind    = simNoise.blockTime(lambda);

   /* Hashers can only start mining the new template after network latency */
   eventQueue.push({
      simClock: simClock + simNoise.owdP2H() + timeToFind,
      poolId:   p.id,
      action:  "HASHER_FIND",
      chaintip: p.chaintip,  // This is the old chaintip blockId that will be extended
      newIds:   null,        // No newId until the event is verified as "sim"-real
   });
   info(() => `simulateBlockTime: ${simClock.toFixed(7)} ${p.id} tip: ${p.chaintip} ` +
       `timeToFind: ${timeToFind.toFixed(0)}`);
}

function hasherFindsBlock(p, eventQueue, activeEvent) {
/*
   We model the exact network/latency relationships that can cause a fork.
   When a pool switches chaintip, there's a window based on pool-to-hasher 1-way
   ping, where the hasher solves the old block before receiving the new template.
*/
   /* The event chaintip must be relevant to the state of the pool (not stale) */
   if (activeEvent.chaintip !== p.chaintip) {                          // Might be stale
      if (activeEvent.chaintip !== blocks[p.chaintip].prevId) return;  // Definitely stale

      /* If hasher would've found the (hypothetical) block after template arrival, return */
      const hasherRecvTime = p.scores[p.chaintip].simClock + simNoise.owdP2H();
      if (activeEvent.simClock > hasherRecvTime) return;
   }

   /* The block is valid from the hasher's perspective. Send to pool */
   let newEvent       = {...activeEvent};
   newEvent.simClock += simNoise.owdP2H();  // Add network latency to future event
   newEvent.action    = "RECV_OWN";
   eventQueue.push(newEvent);

   info(() => `hasherFindsBlock:  ${activeEvent.simClock.toFixed(7)} ${p.id} tip: ${p.chaintip}`);
}

function generateBlock(p, activeEvent) {
   /* The pool could've received a competing block before the hasher's solution arrived */
   if (activeEvent.chaintip !== p.chaintip)                     // Might be stale
      if (activeEvent.chaintip !== blocks[p.chaintip].prevId)   // Definitely stale
         return false;

   /* RECV_OWN is valid. Create a new block and score for the pool */
   const b          =  blocks[activeEvent.chaintip];            // block being extended
   const newBlockId = `${b.height + 1}_${activeEvent.poolId}`;
   const newBlock = {
      simClock:       activeEvent.simClock,
      height:         b.height + 1,
      poolId:         activeEvent.poolId,
      blockId:        newBlockId, 
      prevId:         b.blockId,
      timestamp:      null,                  // Defer, as strategies might manipulate timestamp
      difficulty:     b.nxtDifficulty,
      cumDifficulty:  b.nxtDifficulty + b.cumDifficulty,
      nxtDifficulty:  null,                  // Needs a timestamp. Defer till after strategy
      broadcast:      null,                  // Need pool strategy before deciding to broadcast
   }
   blocks[newBlockId]   = newBlock;
   activeEvent.newIds   = [newBlockId];      // API requires an array

   info(() => `generateBlock:     ${activeEvent.simClock.toFixed(7)} ${p.id} newId: ${newBlockId}`);
   return true;
}

function calculateNextDifficulty(blockId) {
/*
   Full block difficulty adjustment. diffWindows has the timestamps and cumDifficulty of each
   contender chaintip. We extract and sort those arrays to look like difficulty.cpp.
*/
   /* Difficulty adjustment constants */
   const DIFFICULTY_TARGET_V2 = sim.diffTarget;
   const DIFFICULTY_WINDOW    = sim.diffWindow;
   const DIFFICULTY_CUT       = sim.diffCut;
   const DIFFICULTY_LAG       = sim.diffLag;

   if (!diffWindows[blockId]) reconstructDiffWindow(blockId);           // Safety for edge cases

   const diffWindow = [...diffWindows[blockId]]
      .slice(0, -DIFFICULTY_LAG).slice(-DIFFICULTY_WINDOW)  // Discard recent, ensure 720 length
      .sort((a, b) => a.timestamp - b.timestamp);
   const timestamps              = diffWindow.map(h => h.timestamp);
   const cumulative_difficulties = diffWindow.map(h => h.cumDifficulty);
   const length = timestamps.length;
   if (length <= 1) return 1n;                              // Genesis block. Set to `1n` (BigInt)

   /* Determine the cut range for outlier removal */
   let cut_begin, cut_end;
   if (length <= DIFFICULTY_WINDOW - 2 * DIFFICULTY_CUT) {
      cut_begin = 0;
      cut_end = length;
   } else {
      cut_begin = Math.floor(
                  (length - (DIFFICULTY_WINDOW - 2 * DIFFICULTY_CUT) + 1) / 2);
      cut_end = cut_begin + (DIFFICULTY_WINDOW - 2 * DIFFICULTY_CUT);
   }

   /* Calculate the time span from the trimmed, sorted timestamps */
   let time_span = timestamps[cut_end - 1] - timestamps[cut_begin];
   if (time_span === 0) time_span = 1;   // Prevent division by zero
   time_span = BigInt(time_span);        // Convert to BigInt for accuracy in calcs later

   /* Calculate the total work, and the new difficulty */
   const total_work     = cumulative_difficulties[cut_end - 1] - cumulative_difficulties[cut_begin];
   const target_seconds = BigInt(DIFFICULTY_TARGET_V2);
   const new_difficulty = (total_work * target_seconds + time_span - 1n) / time_span;

   info(() => `calcNxtDifficulty: ${blocks[blockId].simClock.toFixed(7)} block: ${blockId} ` +
       `nextDifficulty: ${new_difficulty}`);
   return new_difficulty <= 0n ? 1n : new_difficulty;
}

function broadcastBlock(newIds, eventQueue, activeEvent) {
/*
   Simulate network delays, then create a new RECV event for each pool. Only single blocks are
   broadcast. Strategy functions determine if they need to catch up on history behind that block. 
*/
   /* Guarantee ascending order by height of newIds for new events */
   newIds = newIds.toSorted((a, b) => blocks[a].height - blocks[b].height);

   for (const p of Object.values(pools)) {
      if (p.id === activeEvent.poolId) continue;             // Skip pool who found the block
      eventQueue.push({
         simClock:  activeEvent.simClock + simNoise.owdP2P(),  // Assume fluffy, no BW penalty
         poolId:    p.id,
         action:   "RECV_OTHER",
         chaintip:  null, 
         newIds:    newIds,
      });
   }
   for (const id of newIds) blocks[id].broadcast = true;   // Set the block as broadcast
   info(() => `broadcastBlock:    ${activeEvent.simClock.toFixed(7)} ${activeEvent.poolId} blocks: ${newIds}`);
}

// -----------------------------------------------------------------------------
// SECTION 5: FLOW AND SIM ENGINE
// -----------------------------------------------------------------------------

function integrateStrategyResults(p, eventQueue, activeEvent, results) {
/*
   Had to defer critical state changes / events until receiving results from the plugin strategy.
   Integrate return contract: { chaintip, timestamp, scores, broadcastId }, into the current state. 
   * Correct API handling by strategies is crucial. No other way to achieve strategy modularity.*
*/
   info(() => `integrateStrategy: ${activeEvent.simClock.toFixed(7)} ${p.id} resultip: ${results.chaintip}`);

   /* Remove received blocks (newIds set) from the pool's request list */
   for (const id of activeEvent.newIds || []) p.requestIds.delete(id);

   if (results.timestamp) {
      const oldTip = activeEvent.chaintip;
      const newTip = results.chaintip; 
      const bOld   = blocks[oldTip];
      const bNew   = blocks[newTip];
      bNew.timestamp = results.timestamp;

      /* Difficulty window wasnt updated earlier because sorting with a null timestamp, fails */
      if (!diffWindows[oldTip]) reconstructDiffWindow(oldTip);  // Edge cases can delete needed window
      diffWindows[newTip] = diffWindows[oldTip].slice(1).concat({
         timestamp:     results.timestamp,
         cumDifficulty: bNew.cumDifficulty
      });
      bNew.nxtDifficulty = calculateNextDifficulty(newTip);
   }

   /* Add the new scores to the pool's database, while tracking unscored blocks for sim efficiency */
   if (results.scores) {

      /* Sort by height here, to save a sort later during metrics and data prep */
      results.scores = Object.fromEntries(Object.entries(results.scores)
         .sort(([idA],[idB]) => blocks[idA].height - blocks[idB].height));

      Object.assign(p.scores, results.scores);
      for (const id in results.scores) {
         if (results.scores[id].cumDiffScore === null) p.unscored.set(id, blocks[id].height);
         else p.unscored.delete(id);
      }
   }

   /* Tracking altTip explicitly, helps code-efficiency inside the selfish strategies module */
   if (results.altTip) p.altTip = results.altTip;
   if (p.chaintip !== results.chaintip) {            // Chaintip is the head being mined by the pool
      p.chaintip = results.chaintip;
      simulateBlockTime(eventQueue, p, activeEvent.simClock);
   }

   /* Maintains realism for out-of-order blocks, and partition healing */
   if (results.requestIds) {
      let requestIds = new Set();
      for (const id of results.requestIds) {  // Prevent duplicate future events/requests
         if (!p.requestIds.has(id)) {
            p.requestIds.add(id);
            requestIds.add(id);
         }
      }
      if (requestIds.size > 0) {  // Use heuristic - No fluffy for missing blocks. It's a negligible
         eventQueue.push({        // factor for fast a network, but critical for a degraded network.
            simClock:  activeEvent.simClock + 2*simNoise.owdP2P() + simNoise.transTime()*requestIds.size,
            poolId:    p.id,
            action:   "RECV_OTHER",
            chaintip:  null,                               // Guarantee height-order of newIds
            newIds:    [...requestIds].toSorted((a, b) => blocks[a].height - blocks[b].height),
         });
      }
   }

   if (results.broadcastIds?.length > 0) broadcastBlock(results.broadcastIds, eventQueue, activeEvent);
}

async function runSimCore() {
/* 
   Pool state changes depend on other pools' actions + network delays. We cant simply generate
   and process events sequentially. We simulate latency, and add future events to the queue.
*/ 
   console.log(`[${timeNow()}] Running round: ${idx.toString().padStart(3, '0')}...`);
   simNoise = makeNoiseFunctions();        // Probability distribution functions for sim realism
   const strategies = await makeStrategiesFunctions();  // All strategies functions needed later 

   /* Historical chaintip needs nxtDifficulty for first event. Calculate it now */
   blocks[startTip].nxtDifficulty = calculateNextDifficulty(startTip);

   /* Binary heap time ordering (fast search). 5 checks for ultimate tie breaking resolution */
   const eventQueue = new TinyQueue([], (a, b) => {
      if (a.simClock !== b.simClock) return a.simClock - b.simClock;
      if (a.poolId   !== b.poolId)   return a.poolId.localeCompare(b.poolId);
      if (a.action   !== b.action)   return b.action.localeCompare(a.action); // RECV_OWN first
      if (a.chaintip !== b.chaintip) return a.chaintip.localeCompare(b.chaintip);
      const aNewId = Array.isArray(a.newIds) ? a.newIds.at(-1) : '0';
      const bNewId = Array.isArray(b.newIds) ? b.newIds.at(-1) : '0';
      if (aNewId !== bNewId) return aNewId.localeCompare(bNewId);
      return 0;
   });


   for (const p of Object.values(pools)) simulateBlockTime(eventQueue, p, blocks[startTip].simClock);

   /* Event queue engine. Continuous event creation and execution until depth is reached */
   let activeEvent;
   const simDepth = blocks[startTip].simClock + (sim.simDepth * 3600);
   while (activeEvent = eventQueue.pop()) {   // TinyQueue pop() removes obj with lowest comparator
      if (activeEvent.simClock > simDepth) break;
      info(() => `SimCoreEngine:     ${activeEvent.simClock.toFixed(7)} ` +
          `${activeEvent.poolId} action: ${activeEvent.action}`);

      const p = pools[activeEvent.poolId];

      /* The moment a hasher finds a block */
      if (activeEvent.action === 'HASHER_FIND') {
         hasherFindsBlock(p, eventQueue, activeEvent)
         continue;
      }
      /* The moment a pool receives block solution from one of its hashers */
      if (activeEvent.action === 'RECV_OWN' && !generateBlock(p, activeEvent)) continue;

      /* Strategy function handles both RECV_OWN/RECV_OTHER. The line below is a function call */
      const strategyResults = strategies[p.strategy](activeEvent, p, blocks);

      /* Contract parameters returned from strategy function must be integrated into sim state */
      integrateStrategyResults(p, eventQueue, activeEvent, strategyResults);

      resourceManagement(eventQueue);
   }
   const results = new Object();
   calculateMetrics(results);             // Summarized chain health metrics for main.js
   prepareDataExport(results);
   exitSimWorker(0, results);
}

// Activate crash handling so that we always get logs and available data returned to main
process.on('unhandledRejection', (reason) => {
   info(() => 'unhandledRejection:', reason?.stack || String(reason));
   console.error('unhandledRejection:', reason?.stack || reason);
   exitSimWorker(1);
});
process.on('uncaughtException',  (err)    => {
   info(() => 'uncaughtException:', err?.stack || String(err));
   console.error('uncaughtException:', err?.stack || err);
   exitSimWorker(1);
});

runSimCore();
