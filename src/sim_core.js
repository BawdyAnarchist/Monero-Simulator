/////////////////////////////////
//     SIMULATION   CORE       //
/////////////////////////////////

// -----------------------------------------------------------------------------
// SECTION 1: IMPORTS, CONSTANTS, GLOBAL STATE
// -----------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parentPort, workerData } from 'node:worker_threads';
import v8 from 'v8';
import 'dotenv/config';
import TinyQueue from 'tinyqueue';
import { randomLcg, randomLogNormal, randomExponential } from 'd3-random';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);

/* Data passed by the worker manager in main. They become global pointers (can still mutate them) */ 
const { idx, pools, blocks, startTip, diffWindows, simDepth, enableLog, enableLog2 } = workerData;

/* Difficulty adjustment constants */
const DIFFICULTY_TARGET_V2 = Number(process.env.DIFFICULTY_TARGET_V2);
const DIFFICULTY_WINDOW    = Number(process.env.DIFFICULTY_WINDOW);
const DIFFICULTY_CUT       = Number(process.env.DIFFICULTY_CUT);
const DIFFICULTY_LAG       = Number(process.env.DIFFICULTY_LAG);

/* Critical simulation parameters */
const MANIFEST   = JSON.parse(fs.readFileSync(
                   path.join(__dirname,'../config/strategy_manifest.json'),'utf8'));
const PING       = Number(process.env.PING);             // Avg network ping (ms)
const MBPS       = Number(process.env.MBPS);             // Avg network bandwidth (Mbps)
const CV         = Number(process.env.CV);               // Coefficient of variance
const BLOCK_SIZE = Number(process.env.BLOCK_SIZE);       // (kb)
const SEED       = Number(process.env.SEED) + idx >>> 0; // Reproducible seed, cast as uint32
const rng        = randomLcg(SEED);                      // Quality, reproducible randomness
let   simNoise   = {};                                   // Will hold probability dist functions
let   has_exited = false;

/* Loggers */
const logBuffer = [];
const log  = (...args) => enableLog  && logBuffer.push(`${args.join(' ')}`);
const logBuffer2 = [];
const log2 = (...args) => enableLog2 && logBuffer2.push(`${args.join(' ')}`);

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
   const ping    = PING / 1e3;                                // ms -> sec (sim consistency)
   const sigma   = Math.sqrt(Math.log(1 + CV*CV));            // pool-to-pool (P2P)
   const pingMu  = Math.log(ping) - 0.5 * sigma * sigma;      // One-way latency
   const sigma2  = Math.sqrt(Math.log(1 + CV*CV));            // Pool-to-hasher (P2H) penalty
   const pingMu2 = Math.log(ping*2) - 0.5 * sigma2 * sigma2;  // One-way latency
   const txTime  = BLOCK_SIZE / (MBPS * 1024 / 8)             // Block tx time. Mbps -> KB/sec
   const txMu    = Math.log(txTime) - 0.5 * sigma * sigma;

   /* Seed generator once, then call it later (more efficient) */
   const logNormal = randomLogNormal.source(rng);

   /* Ping spike model: Rare additive delays to mimic burstiness. Scale by PING and CV */
   const spikeProb   = (base_pct) => base_pct - 0.015 + (0.01 * Math.pow(1 + CV, 2));  // magic
   const spikeAmount = (min, max) => ping * (min + (max - min) * rng());      // min-max spike %

   /* One-way-delay probability distribution functions. 10-50% P2P, 20-100% P2H on ping spike */
   const baseP2P = logNormal(pingMu,  sigma);
   const baseP2H = logNormal(pingMu2, sigma2);
   const owdP2P  = () => rng() < spikeProb(0.01) ? baseP2P() + spikeAmount(0.1, 0.5) : baseP2P();
   const owdP2H  = () => rng() < spikeProb(0.04) ? baseP2H() + spikeAmount(0.2, 1.0) : baseP2H();

   return {
      owdP2P:    owdP2P,                             // One-Way-Delay, Pool-to-Pool
      owdP2H:    owdP2H,                             // One-Way-Delay, Pool-to-Hasher
      transTime: logNormal(txMu, sigma),             // Time to send block, not including OWD
      blockTime: randomExponential.source(rng),
   }
}

async function makeStrategiesFunctions() {
/*
   Import modules, then set entryPoints functions in the strategies object. Ideally this would
   be in main.js, but worker threads can't pass functions. Must build it here, inside the worker.
 */
   let strategies = Object.create(null);
   for (const strategy of MANIFEST) {
      const module = await import(path.resolve(__dirname, strategy.module));
      if (typeof module.setLog === 'function') module.setLog(log);   // Inject log into strategy
      const entryPoint = strategy.entryPoint;
      strategies[strategy.id] = module[entryPoint];  // Populate strategies with id and function
   }
   return strategies;
}


// -----------------------------------------------------------------------------
// SECTION 3: HELPERS AND HOUSEKEEPING
// -----------------------------------------------------------------------------

function reconstructDiffWindow(blockId) {
   log(`reconstructDiffWindow: diffWindow missing for ${blockId}. Reconstructing it ...`);
   const diffWindow  = [];
   let loopId = blockId;
   for (let i = 0; i < (DIFFICULTY_WINDOW + DIFFICULTY_LAG) && loopId; i++) {
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

function exitSimWorker(exit_code) {
/* Unified exit and message handling, both success and error */

   if (has_exited) return;   // Prevent any possibility of a double-call (unlikely but defended)
   has_exited = true;

   if (exit_code === 0) {
      const { used_heap_size } = v8.getHeapStatistics();             // Heap RAM usage
      console.log(`Round ${idx.toString().padStart(3, '0')} completed with heap size: ` +
         `${(used_heap_size/1_048_576).toFixed(1)} MB, ${new Date().toLocaleTimeString()}`);
   }

   const filteredBlocks = Object.fromEntries(Object.entries(blocks)  // Filter historical blocks
      .filter(([, b]) => b.height > blocks[startTip].height ));

   parentPort.postMessage({                 // Send data and log back to main.js
      pools:    pools,
      blocks:   filteredBlocks,
      infoLog:  logBuffer.join('\n'),
      probeLog: logBuffer2.join('\n')
   });

   setImmediate(() => process.exit(exit_code));
}


// -----------------------------------------------------------------------------
// SECTION 4: CORE BLOCKCHAIN LOGIC
// -----------------------------------------------------------------------------

function simulateBlockTime(eventQueue, p, simClock) {
/* Simulated a new blockTime, whenever a pool changes chaintip.  */

   const nxtDifficulty = blocks[p.chaintip].nxtDifficulty;
   const lambda        = p.hashrate / Number(nxtDifficulty);  // Downgrade from BigInt
   const timeToFind    = simNoise.blockTime(lambda)();

   /* Hashers can only start mining the new template after network latency */
   eventQueue.push({
      simClock: simClock + simNoise.owdP2H() + timeToFind,
      poolId:   p.id,
      action:  "HASHER_FIND",
      chaintip: p.chaintip,  // This is the old chaintip blockId that will be extended
      newIds:   null,        // No newId until the event is verified as "sim"-real
   });
   log(`simulateBlockTime: ${simClock.toFixed(7)} ${p.id} tip: ${p.chaintip} ` +
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

   log(`hasherFindsBlock:  ${activeEvent.simClock.toFixed(7)} ${p.id} tip: ${p.chaintip}`);
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
      pool:           activeEvent.poolId,
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

   log(`generateBlock:     ${activeEvent.simClock.toFixed(7)} ${p.id} newId: ${newBlockId}`);
   return true;
}

function calculateNextDifficulty(blockId) {
/*
   Full block difficulty adjustment. diffWindows has the timestamps and cumDifficulty of each
   contender chaintip. We extract and sort those arrays to look like difficulty.cpp.
*/
   if (!diffWindows[blockId]) reconstructDiffWindow(blockId);     // Safety for edge cases

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

   log(`calcNxtDifficulty: ${blocks[blockId].simClock.toFixed(7)} block: ${blockId} ` +
       `nextDifficulty: ${new_difficulty}`);
   return new_difficulty <= 0n ? 1n : new_difficulty;
}

function broadcastBlock(newIds, eventQueue, activeEvent) {
/*
   Simulate network delays, then create a new RECV event for each pool. Only single blocks are
   broadcast. Strategy functions determine if they need to catch up on history behind that block. 
*/
   /* Guarantee ascending order by height of newIds for new events */
   newIds = newIds.toSorted((a, b) => +a - +b); // `+a` (unary plus) parse int until first non-digit

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
   log(`broadcastBlock:    ${activeEvent.simClock.toFixed(7)} ${activeEvent.poolId} blocks: ${newIds}`);
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
   log(`integrateStrategy: ${activeEvent.simClock.toFixed(7)} ${p.id} resultip: ${results.chaintip}`);

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

   /* Add the new scores to the miner's database, while tracking unscored blocks for sim efficiency */
   if (results.scores) {
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
            chaintip:  null,
            newIds:    [...requestIds].toSorted((a, b) => +a - +b),  // Guarantee order of newIds
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
   console.log(`Starting round: ${idx.toString().padStart(3, '0')} ...`); 
   simNoise = makeNoiseFunctions();        // Probability distribution functions for sim realism

   const strategies = await makeStrategiesFunctions();  // All strategies functions needed later 

   /* Historical chaintip needs nxtDifficulty for first event. Calculate it now */
   blocks[startTip].nxtDifficulty = calculateNextDifficulty(startTip);

   /* Binary heap time ordering (fast search). 5 checks for ultimate tie breaking resolution */
   const eventQueue = new TinyQueue([], (a, b) => {
      if (a.simClock !== b.simClock) return a.simClock - b.simClock;
      if (a.poolId   !== b.poolId)   return a.poolId.localeCompare(b.poolId);
      if (a.action   !== b.action)   return b.action.localeCompare(a.action); // RECV_OWN first
      if (a.chaintip !== b.chaintip) return +a.chaintip - +b.chaintip;        // Cast numeric blockId
      const aNewId = Array.isArray(a.newIds) ? a.newIds.at(-1) : undefined;
      const bNewId = Array.isArray(b.newIds) ? b.newIds.at(-1) : undefined;
      if (aNewId !== bNewId) return (+aNewId || 0) - (+bNewId || 0);
      return 0;
   });

   for (const p of Object.values(pools)) simulateBlockTime(eventQueue, p, blocks[startTip].simClock);

   /* Event queue engine. Continuous event creation and execution until depth is reached */
   let activeEvent;
   while (activeEvent = eventQueue.pop()) {   // TinyQueue pop() removes obj with lowest comparator
      if (activeEvent.simClock > simDepth) break;
      log(`SimCoreEngine:     ${activeEvent.simClock.toFixed(7)} ` +
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
   exitSimWorker(0);
}

// Activate crash handling so that we always get logs and available data returned to main
process.on('unhandledRejection', (reason) => {
   log('unhandledRejection:', reason?.stack || String(reason));
   console.error('unhandledRejection:', reason?.stack || reason);
   exitSimWorker(1);
});
process.on('uncaughtException',  (err)    => {
   log('uncaughtException:', err?.stack || String(err));
   console.error('uncaughtException:', err?.stack || err);
   exitSimWorker(1);
});

runSimCore();
