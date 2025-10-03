////////////////////////////////////////////
//  MONERO  POW  SIMULATION  COORDINATOR  // 
////////////////////////////////////////////

// -----------------------------------------------------------------------------
// IMPORTS, GLOBALS, HELPERS
// -----------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Worker } from 'node:worker_threads';
import { freemem, availableParallelism } from 'os';
import { gzipSync } from 'node:zlib';
import pLimit from 'p-limit';
import {randomLcg, randomNormal } from 'd3-random';

import { CONFIG } from './config_init.js';

const STATE = new Object();              // Shared state is common to most functions
const rng = randomLcg(CONFIG.env.seed);  // Required to set per-pool ntpDrift
const streams = new Object();            // Write streams for recording results per round
let   headerWritten = false

function dateNow() {
   return new Date().toLocaleString();
}
function timeNow() {
   return new Date().toLocaleTimeString();
}


// -----------------------------------------------------------------------------
// MANAGE DATA STORAGE
// -----------------------------------------------------------------------------

function initializeResultsStorage() {
   /* Create and write the consolidated configuration snapshot for this run */
   const snapshotData = { env: CONFIG.env, sim: CONFIG.sim, parsed: CONFIG.parsed };
   fs.writeFileSync(CONFIG.run.snapshot, JSON.stringify(snapshotData, null, 2));

   /* Initialize the data streams */
   for (const key in CONFIG.data) {
      if (CONFIG.data[key]) {
         streams[key] = fs.createWriteStream(CONFIG.data[key], { flags: 'w' });
         streams[key].on('error', (err) => { console.error(`Stream error for ${key}:`, err); });
      }
   }
   /* Write historical blocks (history not included in results_blocks -> avoid duplicated data) */
   const blockFields = Object.keys(STATE.blocks[STATE.startTip]);
   let csv = blockFields.join(',') + '\n';
   for (const b of Object.values(STATE.blocks))
      csv += blockFields.map(k => b[k]).join(',') + '\n';
   fs.writeFileSync(CONFIG.run.history, Buffer.from(csv));
}

async function recordResultsToCSV(results, log) {
   if (!headerWritten) {
      const headerWrites = [];
      for (const key in streams) {
         if (results.headers[key]) {
            let header = Buffer.from(results.headers[key] + '\n');
            if (CONFIG.data[key].includes('.gz')) header = gzipSync(header);
            headerWrites.push(writeBufferToStream(streams[key], header));
         }
      }
      await Promise.all(headerWrites);
      headerWritten = true;
   }

   const dataWrites = [];
   for (const key in streams)
      if (results[key]) dataWrites.push(writeBufferToStream(streams[key], results[key]));
   await Promise.all(dataWrites);

   for (const key in log) if (CONFIG.log[key])
      fs.appendFileSync(CONFIG.log[key], `${key.toUpperCase()} GENERATED: ${dateNow()}\n${log[key]}`);
}

async function writeBufferToStream(stream, buf) {
   /* The check is necessary for efficient chunk queueing/buffer */
   if (!stream.write(buf)) await new Promise(resolve => stream.once('drain', resolve));
}

async function gracefulShutdown() {
   const streamShutdowns = Object.values(streams).map(stream => {
      return new Promise(resolve => {
         stream.on('finish', resolve);
         stream.end();
      });
   });
   await Promise.all(streamShutdowns);
}


// -----------------------------------------------------------------------------
// SHARED STATE INITIALIZATION
// -----------------------------------------------------------------------------

function importHistory() {
/*
   Populate `blocks` with 735 blocks of history for difficulty adjustment calculation. A
   stateful rolling `diffWindows` avoids a walkback loop via prevId on every new block. 
*/
   const history = fs.readFileSync(CONFIG.config.history, 'utf8')
      .split(/\r?\n/).filter(l => l.trim()).slice(1)
      .sort((a, b) => +a.split(',')[0] - +b.split(',')[0]);

   if (history.length < CONFIG.sim.diffWindow + CONFIG.sim.diffLag) throw new Error(
      `${CONFIG.config.history} is too short. ` +
      `Needs ${CONFIG.sim.diffWindow + CONFIG.sim.diffLag} blocks for bootstrap`
   );

   let blocks     = Object.create(null);
   let diffWindow = [];
   let blockId, height, timestamp, difficulty, cumulative_difficulty;

   for (const line of history) {
      [height, timestamp, difficulty, cumulative_difficulty] = line.split(',');
      blockId = `${+height}_HH0`;
      const newBlock = {
         simClock:      +timestamp,             // "True" Unix date the moment block was found by pool 
         height:        +height,
         poolId:        "HH0",
         blockId:        blockId,               // For sim simplicity, blockId is just 'height_pool' 
         prevId:        `${+height - 1}_HH0`,
         timestamp:     +timestamp,             // Block header epoch
         difficulty:     BigInt(difficulty),    // BigInt coz it gets added to cumDifficulty 
         nxtDifficulty:  null,                  // Difficulty required to mine the next block
         cumDifficulty:  BigInt(cumulative_difficulty),  // Maintain precision with BigInt
         broadcast:      true,                  // Tracks whether the pool has broadcast the block yet
      }
      blocks[blockId] = newBlock;
      diffWindow.push({
         timestamp:     +timestamp,
         cumDifficulty:  BigInt(cumulative_difficulty)
      });
   }  

   /* Scores history irrelevant except the last historical block (chaintip continuity at sim start) */
   const hScore = {                                 // "Weakly subjective" pool perspective
      simClock:      +timestamp,
      localTime:     +timestamp,                    // Pool's local Unix date of header arrival
      diffScore:     blocks[blockId].difficulty,    // Base difficulty with penalties/bonuses applied
      cumDiffScore:  blocks[blockId].cumDifficulty, // Cumulative scored difficulty
      chaintip:      blockId,                       // Pools' real-time believe of the canonical chain
      isHeadPath:    true,                          // Pools' real-time believe of the canonical chain
   }

   if (diffWindow.length > CONFIG.sim.diffWindow + CONFIG.sim.diffLag)
         diffWindow = diffWindow.slice(-(CONFIG.sim.diffWindow + CONFIG.sim.diffLag));
   let diffWindows      = Object.create(null);
   diffWindows[blockId] = diffWindow;  

   STATE.blocks      = blocks;
   STATE.hScore      = hScore;         // For sim_engine startup, score of the historical chaintip
   STATE.startTip    = blockId;        // blockId is the chaintip of the historical blocks
   STATE.diffWindows = diffWindows;
}

function initializePools() {
/* 
   Pools need initialized with basic parameters. Historic scores are identical between pools
   (we lack that data anyways), but we do simulate ntpDrift for the most recent historical block.
*/
   const normalNtp = randomNormal.source(rng)(0, CONFIG.sim.ntpStdev);  // Build once, use in loop
   const startTip  = STATE.startTip;
   for (const poolKey in STATE.pools) {
      const p        = STATE.pools[poolKey];
      const ntpDrift = normalNtp();
      const score    = { ...STATE.hScore,
                            localTime: Math.floor(STATE.hScore.localTime + ntpDrift) };
      p.id           = poolKey;                     // Enrich with id=Key for simplicity later
      p.ntpDrift     = ntpDrift;                    // Persistent ntp drift
      p.hashrate     = p.HPP * CONFIG.sim.hashrate; //hashrate based on hashpower percentage
      p.chaintip     = startTip;                    // Last guaranteed historical common ancestor
      p.altTip       = null;                        // For selfish pools to track honest chaintip
      p.scores       = Object.create(null);
      p.scores[startTip] = score;                   // Apply score to last historical block
      p.requestIds   = new Set();                   // Missing blocks requested from the network
      p.unscored     = new Map();                   // Unscored blocks waiting on ancestor score(s)
      p.config = CONFIG.parsed.manifest.find(
         s => s.id === p.strategy).config;           // Save strategy manifest config
   }
}


// -----------------------------------------------------------------------------
// STATE DERIVATIONS and RESOURCE CALCULATION
// -----------------------------------------------------------------------------

function derivePermutations() {
   const sweeps = CONFIG.parsed.sweeps;
   if (!sweeps) return null;

   const dimensions = [];
   const findArrays = (obj, path = []) => {
      for (const key in obj) {
         const newPath = path.concat(key);
         if (Array.isArray(obj[key])) {
            dimensions.push({ path: newPath, values: obj[key] });
         } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            findArrays(obj[key], newPath);
         }
      }
   };
   findArrays(sweeps);

   if (dimensions.length === 0) return [];

   return dimensions.reduce((a, b) =>
      a.flatMap(x => b.values.map(y => [...x, { path: b.path, value: y }])),
   [[]]);
}

function calculateResourceUsage(perms) {
/*
   There's alot of magic here, tuned to various loads/regimes on my personal machine.
   Heap/RAM should be close, but timeEst is going to vary significantly. 
*/
   /* Modifiers */
   const rounds  = perms ? perms.length : CONFIG.env.simRounds;
   const speed   = [ 'simple', 'metrics' ].includes(CONFIG.env.dataMode) ? 230 : 180
   const logPenT = [ 'info', 'probe', 'stats' ].includes(CONFIG.env.logMode) ? 1.7 : 1
   const logPenR = [ 'info', 'probe', 'stats' ].includes(CONFIG.env.logMode) ? 7.2 : 1
   const workers = Math.min(CONFIG.env.workers, rounds);
   const effWork = (workers / (1 + workers/9 ));   // Non-linear benefit of adding workers
   /* Usage */
   const seconds = Math.ceil((CONFIG.sim.depth * rounds * logPenT) / (speed * effWork));
   const heapAvg = Math.ceil((CONFIG.sim.depth * logPenR) / 6);   // Avg: ~1MB per 6 sim-hours
   const heapMax = Math.ceil(heapAvg * 1.4 + 100);
   const ramTot  = workers * heapAvg / 1024;
   /* With units */
   const heapEst = `${heapAvg}/${heapMax} MB (avg/max)`;  // Spike heap
   const ramEst  = `${ramTot.toFixed(1)} GB`;
   const timeEst =
      seconds > 7200 ? `${(seconds / 3600).toFixed(1)} hrs` :
      seconds > 120  ? `${(seconds / 60).toFixed(1)} mins` : `${seconds} secs`;

   /* Flag and provide data when the user is submaxing their CPU threads */
   const flagThreads = CONFIG.env.workers < rounds && CONFIG.env.workers < 4 * availableParallelism();
   return { rounds, heapAvg, heapMax, ramTot, timeEst, heapEst, ramEst, flagThreads };
}

function assembleSweepState(perm, idx) {
/*
   Each worker needs the individual permutation wrapped into `config` and `state`. Much of the difficulty
   of this function is actually the permutation values along with header labels.  Note: This function was
   entirely LLM vibed. This is a significant break from the rest of the codebase, which was human built.
*/
   const config = structuredClone(CONFIG);
   const state = structuredClone(STATE);

   const setValue = (obj, path, val) => {
      path.slice(0, -1).forEach(key => obj = obj[key]);
      obj[path[path.length - 1]] = val;
   };

   /* This implements the simplified pools sweep syntax in sweeps.json */
   let attackerHppChanged = false;
   for (const { path, value } of perm) {
      const key = path[0];
      if (key === 'difficulty' || key === 'internet' || key === 'dynamic') {
         setValue(config.parsed[key], path.slice(1), value);
      } else if (key === 'strategies') {
         const strategyId = path[1];
         const manifestEntry = config.parsed.manifest.find(s => s.id === strategyId);
         if (manifestEntry) setValue(manifestEntry, path.slice(2), value);
      } else if (key === 'pools') {
         const poolKey = path[1];
         const property = path[2];
         if (poolKey === 'HONEST') {
            Object.values(state.pools).filter(p => p.id !== 'P0').forEach(p => p.strategy = value);
         } else {
            state.pools[poolKey][property] = value;
            if (property === 'HPP') attackerHppChanged = true;
         }
      }
   }
   if (attackerHppChanged) {
      const attackerId = 'P0';
      const attackerNewHpp = state.pools[attackerId].HPP;
      const honestOldHppSum = 1 - STATE.pools[attackerId].HPP;
      const honestNewHppSum = 1 - attackerNewHpp;
      if (honestOldHppSum > 1e-9) {
         Object.values(state.pools).filter(p => p.id !== attackerId).forEach(p => {
            p.HPP = (STATE.pools[p.id].HPP / honestOldHppSum) * honestNewHppSum;
         });
      }
   }

   config.sim = {
      ...CONFIG.sim,
      diffTarget: Number(config.parsed.difficulty.DIFFICULTY_TARGET_V2),
      hashrate:   Number(config.parsed.difficulty.NETWORK_HASHRATE),
      ping:       Number(config.parsed.internet.PING),
      cv:         Number(config.parsed.internet.CV),
      mbps:       Number(config.parsed.internet.MBPS),
      ntpStdev:   Number(config.parsed.internet.NTP_STDEV)
   };

   for (const p of Object.values(state.pools)) {
      p.hashrate = p.HPP * config.sim.hashrate;
      p.config = config.parsed.manifest.find(s => s.id === p.strategy)?.config;
   }

   /* Build sweep labels using CONFIG.run.labelRule:
      - Nearest-parent wins; if no match, fallback depth = 0 (use last).
      - Depth = -1: prefer parent's 'id' (if present), else use parent name; then append last.
      - Join parts with underscore. */
   const resolveDepth = (path) => {
      let node = config.run && config.run.labelRule ? config.run.labelRule : null;
      let depth = undefined;
      for (let i = 0; i < path.length; i++) {
         if (node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, path[i])) {
            const next = node[path[i]];
            if (typeof next === 'number') { depth = next; break; }
            node = next;
         } else break;
      }
      if (typeof node === 'number') depth = node;
      if (depth === undefined) depth = 0;
      return depth;
   };

   const getParentIdIfExists = (path) => {
      const parentPath = path.slice(0, -1);
      if (parentPath.length === 0) return null;

      let obj = null;
      const root = parentPath[0];

      if (root === 'pools') {
         const poolKey = parentPath[1];
         obj = state.pools && state.pools[poolKey] ? state.pools[poolKey] : null;
      } else if (root === 'strategies') {
         const strategyId = parentPath[1];
         obj = config.parsed.manifest.find(s => s.id === strategyId) || null;
         for (let i = 2; i < parentPath.length && obj; i++) obj = obj[parentPath[i]];
      } else if (root === 'difficulty' || root === 'internet' || root === 'dynamic') {
         obj = config.parsed[root];
         for (let i = 1; i < parentPath.length && obj; i++) obj = obj[parentPath[i]];
      }

      if (obj && typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, 'id')) {
         const idVal = obj.id;
         if (idVal !== null && idVal !== undefined && (typeof idVal === 'string' || typeof idVal === 'number'))
            return String(idVal);
      }
      return null;
   };

   const makeLabel = (path) => {
      const last = path[path.length - 1];
      const depth = resolveDepth(path);

      if (depth === -1) {
         const parentId = getParentIdIfExists(path);
         const parent = parentId || path[path.length - 2];
         return `${parent}_${last}`;
      }
      if (depth <= 0) return `${last}`;

      const take = Math.min(depth + 1, path.length);
      const parts = path.slice(path.length - take);
      return parts.join('_');
   };

   const sweepPairs = perm.map(({ path, value }) => {
      const keyFull  = path.join('.');
      const keyShort = makeLabel(path);
      return { keyFull, keyShort, value };
   });

   config.run.sweepPerm   = Object.fromEntries(sweepPairs.map(p => [p.keyFull, p.value]));
   config.run.sweepHeader = sweepPairs.map(p => p.keyShort);
   config.run.sweepPairs  = sweepPairs;
   config.run.sweepId     = idx;

   return { config, state };
}


// -----------------------------------------------------------------------------
// FLOW CONTROL
// -----------------------------------------------------------------------------

function getUserPermission(perms) {
   if (!process.stdout.isTTY) return Promise.resolve();
   const { rounds, heapAvg, heapMax, ramTot, timeEst, heapEst, ramEst, flagThreads }
      = calculateResourceUsage(perms);

   if (flagThreads) console.log(`\x1b[36m[TIP]: For max speed, assign as many WORKERS as you have ` +
      `rounds, up to 4-8x your system thread count of: ${availableParallelism()}\x1b[0m\n`);

   console.log(`## ESTIMATED RESOURCE USAGE ##\n  ` +
      `Total Rounds:    ${rounds}\n  ` +
      `RAM per Worker:  ${heapEst}\n  ` +
      `RAM Total:       ${ramEst}\n  ` +
      `COMPLETION TIME: \x1b[36m${timeEst}\x1b[0m`);

   if (freemem() / (1024**3) < ramTot) console.log(`\x1b[33m[Warning]: DEPTH*WORKERS might ` +
      `be to high for your total free system RAM: ${(freemem()/(1024**3)).toFixed(2)} GB\x1b[0m`);

   if (CONFIG.env.workerRam < heapMax) console.log(`\x1b[33m[Warning]: WORKER_RAM ` +
      `might be too low. Only ${CONFIG.env.workerRam} MB is allocated in .env\x1b[0m`);

   /* Readline prompt and user response switch */
   const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
   return new Promise((resolve) => {
      rl.question('CONTINUE? (y/N): ', answer => {
         rl.close(`\n`);
         if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') resolve();
         else process.exit(0);
      });
   });
}

function callOrchestrationWorker(idx, config, state) {
/*
   Spawn a worker that runs one, memory isolated simulation round.
   Returns a promise that resolves with a data object (or rejection/error).
*/
   return new Promise((resolve, reject) => {
      const worker = new Worker(
         new URL('./round_orchestrator.js', import.meta.url), {
            workerData: { idx, config, state },
            resourceLimits: { maxOldGenerationSizeMb: CONFIG.env.workerRam },
         }
      );
      let result;
      let errorObj;
      worker.once('message', (data) => { result = data; });
      worker.once('error',   (err)  => { errorObj = err; });
      worker.once('exit',    (code) => {
         setImmediate(() => {
            if (code === 0) {
               if (result !== undefined) resolve(result);
               else reject(new Error(`Worker ${idx} exited without sending results`));
            } else {
               const err = errorObj || new Error(`Worker ${idx} exited with code ${code}`);
               if (result !== undefined) err.result = result;
               reject(err);
            }
         });
      });
   });
}

async function main() {
/* 
   Central coordinator for pluggable/configurable history, pools, and strategies.
   Sets configs, then manages multi-thread simulation execution and data delivery.
*/
   /* Conduct checks and prepare the shared STATE */
   STATE.pools = JSON.parse(JSON.stringify(CONFIG.parsed.pools));
   importHistory();                     // Add critical historical data to STATE
   initializePools();                   // Add pools: ntpDrift, hashrate, and hScore to STATE
   const perms = derivePermutations();  // Returns an array. `null` if sweeps arent enabled
   Object.freeze(STATE);                // Immutable shared state

   await getUserPermission(perms);      // User permission for > 60 sec estimated runtime
   initializeResultsStorage();          // Set up streams to receive worker returned data

   /* Prepare the worker callback functions */
   const limit = pLimit(CONFIG.env.workers);
   let jobs;
   if (perms) {
      jobs = perms.map((perm, idx) => ({
         idx,
         promise: limit(() => {
            const { config, state } = assembleSweepState(perm, idx);
            return callOrchestrationWorker(idx, config, state);
         })
      }));
   } else {
      jobs = Array.from({ length: CONFIG.env.simRounds }, (_, idx) => ({
         idx,
         promise: limit(() => callOrchestrationWorker(idx, CONFIG, STATE))
      }));
   }

   /* Await each job’s completion (order of resolution is not important) */
   console.log(`\n[${timeNow()}] Environment checks good, starting sim rounds...`);
   for (const { idx, promise } of jobs) {
      try {
         const { results: results, log: log, } = await promise;  // Destructure results
         await recordResultsToCSV(results, log);                 // Record results
      } catch (error) {
         if (error.result?.results)         // Write whatever results are available
            await recordResultsToCSV(error.result.results, error.result.log || {});
         console.error(`[${timeNow()}] FAILURE on round: ${idx}:`, error.message);
         break;
      }
   }
   await gracefulShutdown();
   console.log(`[${timeNow()}] Sim complete. Exiting.\n`);
}

process.once('SIGINT', async () => {   // Callbacks for signal exits
   console.log('\nSIGINT/SIGTERM detected. Abandoning simulation.');
   await gracefulShutdown();
   process.exit(0);
});
process.once('SIGTERM', async () => {
   console.log('\nSIGINT/SIGTERM detected. Abandoning simulation.');
   await gracefulShutdown();
   process.exit(0);
});

main().catch(err => {
   console.error('\nA critical error occurred during execution:', err);
   const errorMsg = `[ ${dateNow()} ] Critical main() error: ${err.stack || err}\n`;
   fs.appendFileSync(CONFIG.log.error, errorMsg);
   process.exit(1);



});
