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
import { availableParallelism } from 'os';
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
/* Loops over the keys in streams and logs to write headers, data, and logs */
   if (!headerWritten) {
      const headerWrites = [];  // generic promise object to await stream write completion
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

   const dataWrites = [];         // generic promise object to await stream write completion
   for (const key in streams) dataWrites.push(writeBufferToStream(streams[key], results[key]));
   await Promise.all(dataWrites);

   for (const key in log) if (CONFIG.log[key])  
      fs.writeFileSync(CONFIG.log[key], `${key.toUpperCase()} GENERATED: ${dateNow()}\n${log[key]}`);
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
   /* Modifiers */
   const rounds  = perms ? perms.length : CONFIG.env.simRounds;
   const speed   = [ 'simple', 'metrics' ].includes(CONFIG.env.dataMode) ? 250 : 200
   const penalty = [ 'info', 'probe', 'stats' ].includes(CONFIG.env.logMode) ? 1.5 : 1
   const workers = CONFIG.env.workers / (1 + CONFIG.env.workers / 9 );  // Non-linear benefit. Magic
   /* Usage */
   const seconds = Math.ceil((CONFIG.sim.depth * rounds * penalty) / (speed * workers));
   const megas   = Math.ceil((CONFIG.sim.depth * penalty) / 4);  // Top quartile: ~1MB / 4 sim-hours
   /* With units */
   const heapEst = `${megas} MB`;
   const timeEst =
      seconds > 7200 ? `${(seconds / 3600).toFixed(1)} hrs` :
      seconds > 120  ? `${(seconds / 60).toFixed(1)} mins` : `${seconds} secs`;

   /* Flag and provide data when the user is submaxing their CPU threads */
   const flagThreads = CONFIG.env.workers < rounds && CONFIG.env.workers < 4 * availableParallelism();
   return { rounds, megas, timeEst, heapEst, flagThreads };
}

function assembleSweepState(perm, idx) {
   const config = structuredClone(CONFIG);
   const state = structuredClone(STATE);

   const setValue = (obj, path, val) => {
      path.slice(0, -1).forEach(key => obj = obj[key]);
      obj[path[path.length - 1]] = val;
   };

   let attackerHppChanged = false;
   for (const { path, value } of perm) {
      const key = path[0];
      if (key === 'difficulty' || key === 'internet') {
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

   config.run.sweepPermutation = perm.reduce((acc, { path, value }) => {
      acc[path.join('.')] = value; return acc; }, {});
   config.run.sweepId = idx;

   return { config, state };
}


// -----------------------------------------------------------------------------
// FLOW CONTROL
// -----------------------------------------------------------------------------

function getUserPermission(perms) {
   if (!process.stdout.isTTY) return Promise.resolve();
   const { rounds, megas, timeEst, heapEst, flagThreads } = calculateResourceUsage(perms);

   if (flagThreads) console.log(`\x1b[36m[TIP]: For max speed, assign as many WORKERS as you have ` +
      `rounds, up to 4-8x your system thread count of: ${availableParallelism()}\x1b[0m\n`);

   console.log(`## ESTIMATED RESOURCE USAGE ##\n  ` +
      `Total Rounds:    ${rounds}\n  ` +
      `RAM per Worker:  ${heapEst}\n  ` +
      `Completion Time: ${timeEst}`);

   if (CONFIG.env.workerRam < megas * 1.3) console.log(` \x1b[33m[Warning]\x1b[0m: ` +
      `WORKER_RAM might be too low. Only ${CONFIG.env.workerRam} MB is allocated in .env`);

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
         console.error(`[${timeNow()}] FAILURE on round: ${idx}:`, error.message);
         if (CONFIG.log.info && error.result?.log?.info)
            fs.writeFileSync(CONFIG.log.info, `WORKER ${idx} LOG\n${error.result.log.info}\n`);
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
