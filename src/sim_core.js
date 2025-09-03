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
const { idx, pools, blocks, startTip, diffWindows, simDepth } = workerData;

/* Difficulty adjustment constants */
const BLOCKTIME            = Number(process.env.BLOCKTIME);
const DIFFICULTY_TARGET_V2 = Number(process.env.DIFFICULTY_TARGET_V2);
const DIFFICULTY_WINDOW    = Number(process.env.DIFFICULTY_WINDOW);
const DIFFICULTY_CUT       = Number(process.env.DIFFICULTY_CUT);
const DIFFICULTY_LAG       = Number(process.env.DIFFICULTY_LAG);

/* Critical simulation parameters */
const MANIFEST    = JSON.parse(fs.readFileSync(
                    path.join(__dirname,'../config/strategy_manifest.json'),'utf8'));
const FORK_WINDOW = Number(process.env.FORK_WINDOW);      // Max time window of fork probability
const FORK_DECAY  = Number(process.env.FORK_DECAY);       // Slope of fork-probability decay 
const NTP_STDEV   = Number(process.env.NTP_STDEV);        // Standard deviation of pool NTP error 
const PING_AVG    = Number(process.env.PING_AVG);         // Avg 1-way ping-delay, pool-to-hashers 
const BLK_TX_AVG  = Number(process.env.BLK_TX_AVG);       // Avg transmission time of full block data 
const SEED        = Number(process.env.SEED) + idx >>> 0; // Reproducible seed, cast as uint32
const rng         = randomLcg(SEED);                      // Quality, reproducible randomness
let   simNoise    = {};                                   // Will hold probability dist functions 

/* Debug helper */
const debug = (() => {
  if (process.env.DEBUG === 'true') return (...m) => console.log('[DBG]', ...m);
  return () => {};
})();


// -----------------------------------------------------------------------------
// SECTION 2: ONE TIME INTIALIZATION FUNCTIONS 
// -----------------------------------------------------------------------------

function makeNoiseFunctions() {
/* Prepare random distribution functions and their constants once, in advance */

   /* LogNormal implementation for ping and bandwidth. Converts simplified mean/stdev to mu/sigma */
   const cv       = 0.5;                                // Hard coded CV
   const sigma2   = Math.log(1 + cv*cv);
   const sigma    = Math.sqrt(sigma2);
   const pingMean = PING_AVG / 1e3;                     // ms -> sec
   const pingMu   = Math.log(pingMean) - 0.5 * sigma2;  // Packet time (one way, not round trip)
   const bwMean   = BLK_TX_AVG / 1e3;                   // ms -> sec
   const bwMu     = Math.log(bwMean)   - 0.5 * sigma2;  // Time to send full block ("bandwidth")
   const makeLogNormal = randomLogNormal.source(rng);   // Declare once, more efficient 

   return {
      block : randomExponential.source(rng),
      ping  : makeLogNormal(pingMu, sigma),
      bw    : makeLogNormal(bwMu, sigma),
      fork  : (dt) =>                      // Near-overlap blockTime fork probability. Exp decay
         dt < FORK_WINDOW && rng() < Math.exp(-FORK_DECAY * dt / FORK_WINDOW)
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
      const entryPoint = strategy.entryPoint;
      strategies[strategy.id] = module[entryPoint];  // Populate strategies with id and function
   }
   return strategies;
}

// -----------------------------------------------------------------------------
// SECTION 3: CORE BLOCKCHAIN LOGIC
// -----------------------------------------------------------------------------

function simulateBlockTime(eventQueue, p, simClock) {
/*
   Block times are simulated whenever a pool changes chaintip.
*/
   const nxtDifficulty = blocks[p.chaintip].nxtDifficulty;
   const lambda        = p.hashrate / Number(nxtDifficulty);  // Downgrade from BigInt
   const timeToFind    = simNoise.block(lambda)();            // monotonic seconds

   /* blockTimes are called at the simClock moment of RECV or CREATE. No ntp adjustment needed here */ 
   simClock += timeToFind;
   eventQueue.push({
      simClock: simClock,
      poolId:   p.id,
      action:  "CREATE_BLOCK",
      chaintip: p.chaintip,   // This is the old chaintip blockId that will be extended
      newTip:   null,         // Save lookup/calc cost until event is verified sim-"real"
   });
   debug(`simulateBlockTime END: clock: ${simClock}, pId: ${p.id}, TTF: ${timeToFind}, tip: ${p.chaintip}`);
}

function generateBlock(p, activeEvent) {
/*
   Any updates to the pool's chaintip, queues a future generateBlock event. However, the pool
   might've already abandoned their mining efforts on the activeEvent chaintip. This can be 
   identified by comparing the pool's current chaintip (and/or prevId) against the activeEvent.
*/
   const localTime = activeEvent.simClock + p.ntpDrift;  // Simulated ntpDrift for new event
   if (activeEvent.chaintip !== p.chaintip) {       // Chaintip mismatch - likely a stale event
      const prevId = blocks[p.chaintip].prevId;
      if (activeEvent.chaintip !== prevId) return;  // Discard event if not shared 1-block ancestor
      const df = localTime - p.scores[p.chaintip].localTime; 
      if (!simNoise.fork(df)) return false;         // Discard event if fork probability fails
   }
   /* CREATE is valid. Create a new block and score for the pool */
   const b          =  blocks[activeEvent.chaintip];
   const newBlockId = `${b.height + 1}_${activeEvent.poolId}`;

   const newBlock = {
      simClock:       activeEvent.simClock,
      height:         b.height + 1,
      pool:           activeEvent.poolId,
      blockId:        newBlockId, 
      prevId:         b.blockId,
      timestamp:      null,                     // Defer, as strategies might manipulate timestamp
      difficulty:     b.nxtDifficulty,
      cumDifficulty:  b.nxtDifficulty + b.cumDifficulty,
      nxtDifficulty:  null,                     // Needs a timestamp. Defer till after strategy
      broadcast:      null,                     // Need pool strategy before deciding to broadcast 
   }
   const newScore = {
      localTime:      Math.floor(localTime),
      diffScore:      b.nxtDifficulty,
      cumDiffScore:   b.nxtDifficulty + p.scores[b.blockId].cumDiffScore,
      isHeaviest:     true,
   }
   blocks[newBlockId]   = newBlock;
   p.scores[newBlockId] = newScore;
   p.chaintip           = newBlockId;
   activeEvent.newTip   = newBlockId;
   debug(`generateBlock END: clock: ${activeEvent.simClock}, pId: ${p.id}, newId: ${newBlockId}`);
   return true;
}

function calculateNextDifficulty(blockId) {
/*
   Full block difficulty adjustment. diffWindows has the timestamps and cumDifficulty of each
   contender chaintip. We extract and sort those arrays to look like difficulty.cpp.
*/
   debug(`calculateNextDifficulty START: blockId: ${blockId}`);
   const diffWindow = [...diffWindows[blockId]]
      .slice(0, DIFFICULTY_WINDOW)
      .sort((a, b) => a.timestamp - b.timestamp);
   const timestamps              = diffWindow.map(h => h.timestamp);
   const cumulative_difficulties = diffWindow.map(h => h.cumDifficulty);
   const length = timestamps.length;
   if (length <= 1) return 1n;                         // Is genesis block. Set to `1n` (BigInt) 

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

   debug(`calculateNextDifficulty END: block: ${blockId}, newDifficulty: ${new_difficulty}`);
   return new_difficulty <= 0n ? 1n : new_difficulty;
}

function broadcastBlock(blockId, eventQueue, activeEvent) {
/*
   Simulate network delays, then create a new RECV event for each pool. Only single blocks are
   broadcast. Strategy functions determine if they need to catch up on history behind that block. 
*/
   blocks[blockId].broadcast = true;
   for (const p of Object.values(pools)) {
      if (p.id === activeEvent.poolId) continue;      // Skip pool who found the block
      eventQueue.push({
         simClock:  activeEvent.simClock + simNoise.ping() + simNoise.bw(),
         poolId:    p.id,
         action:   "RECV_BLOCK",
         chaintip:  null, 
         newTip:    blockId,
      });
   debug(`broadcastBlock LOOPend: clock: ${activeEvent.simClock}, pId: ${p.id}, block: ${blockId}`);
   }
}

// -----------------------------------------------------------------------------
// SECTION 4: FLOW AND SIM ENGINE
// -----------------------------------------------------------------------------

function sendDataToMain() {
/* Console messaging, trim historical blocks, and send data objects back to main.js  */ 
   const { total_heap_size, used_heap_size } = v8.getHeapStatistics();
      console.log(`Round ${idx.toString().padStart(3, '0')} completed with ` +
         `heap size: ${(used_heap_size/1_048_576).toFixed(1)} MB, ${new Date().toLocaleTimeString()}`);

   const filteredBlocks = Object.fromEntries(Object.entries(blocks)
      .filter(([, b]) => b.height > blocks[startTip].height ));
   parentPort.postMessage({ pools: pools, blocks: filteredBlocks });
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
   if (eventQueue.data.length = eventQueue.length * 3) eventQueue.data.length = eventQueue.length;
}

function integrateStrategyResults(p, eventQueue, activeEvent, results) {
/*
   Had to defer critical state changes / events until receiving results from the plugin strategy.
   Integrate return contract: { chaintip, timestamp, scores, broadcastId }, into the current state. 
*/
   debug(`integrateStrategy BEGIN: clock: ${activeEvent.simClock}, pId: ${p.id}, tip: ${results.chaintip}`);
   if (results.timestamp) {
      const oldTip = activeEvent.chaintip;
      const newTip = results.chaintip; 
      const bOld   = blocks[oldTip];
      const bNew   = blocks[newTip];
      bNew.timestamp = results.timestamp;

      /* Difficulty window wasnt updated earlier because sorting with a null timestamp, fails */
      diffWindows[newTip] = diffWindows[oldTip].slice(1).concat({
         timestamp:     results.timestamp,
         cumDifficulty: bNew.cumDifficulty
      });
      bNew.nxtDifficulty = calculateNextDifficulty(newTip);
   }
   if (results.scores) Object.assign(p.scores, results.scores);
   if (results.chaintip === activeEvent.newTip) {
      p.chaintip = results.chaintip;
      simulateBlockTime(eventQueue, p, activeEvent.simClock);   // New chaintip means switch to new block 
   }
   if (results.broadcastId) broadcastBlock(results.broadcastId, eventQueue, activeEvent);
   debug(`integrateStrategy END: clock: ${activeEvent.simClock}`);
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

   /* Create a binary heap for time ordering (fast search), then populate queue with first events */
   const eventQueue = new TinyQueue([], (a, b) => a.simClock - b.simClock);
   for (const p of Object.values(pools)) simulateBlockTime(eventQueue, p, blocks[startTip].simClock);

   /* Event queue engine. Continuous event creation and execution until depth is reached */
   let activeEvent;
   while (activeEvent = eventQueue.pop()) {   // TinyQueue pop() removes obj with lowest comparator
      debug(`runSimCORE LOOPstart: activeEvent`, activeEvent);
      if (activeEvent.simClock > simDepth) break;
      const p = pools[activeEvent.poolId];

      if (activeEvent.action === 'CREATE_BLOCK' && !generateBlock(p, activeEvent)) continue;

      /* Strategy function must handle both CREATE/RECV. The line below is a function call */
      const strategyResults = strategies[p.strategy](activeEvent, p, blocks);

      /* Contract parameters returned from strategy function must be integrated into sim state */
      integrateStrategyResults(p, eventQueue, activeEvent, strategyResults);

      resourceManagement(eventQueue);
      debug(`runSimCORE LOOPend: queue_length:`, eventQueue.length);
   }
   sendDataToMain();
}

runSimCore();
