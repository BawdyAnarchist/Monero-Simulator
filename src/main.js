////////////////////////////////////////////
//  MONERO  POW  SIMULATION  COORDINATOR  // 
////////////////////////////////////////////

// -----------------------------------------------------------------------------
// IMPORTS, GLOBALS, HELPERS
// -----------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import pLimit from 'p-limit';
import {randomLcg, randomNormal } from 'd3-random';

import { CONFIG } from './config_init.js';

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

function initializeResultsStorage(state) {
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
   const blockFields = Object.keys(state.blocks[state.startTip]);
   let csv = blockFields.join(',') + '\n';
   for (const b of Object.values(state.blocks))
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
// SIM STATE INITIALIZATION
// -----------------------------------------------------------------------------

function importHistory(state) {
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

   state.blocks      = blocks;
   state.hScore      = hScore;         // For sim_core startup, score of the historical chaintip
   state.startTip    = blockId;        // blockId is the chaintip of the historical blocks
   state.diffWindows = diffWindows;
}

function initializePools(state) {
/* 
   Pools need initialized with basic parameters. Historic scores are identical between pools
   (we lack that data anyways), but we do simulate ntpDrift for the most recent historical block.
*/
   const normalNtp = randomNormal.source(rng)(0, CONFIG.sim.ntpStdev);  // Build once, use in loop
   const startTip  = state.startTip;
   for (const poolKey in state.pools) {
      const p        = state.pools[poolKey];
      const ntpDrift = normalNtp();
      const score    = { ...state.hScore,
                            localTime: Math.floor(state.hScore.localTime + ntpDrift) };
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
// FLOW CONTROL AND MANAGEMENT
// -----------------------------------------------------------------------------

function runSimCoreInWorker(idx, CONFIG, state) {
/*
   Spawn a worker that runs one, memory isolated simulation round.
   Returns a promise that resolves with a data object (or rejection/error).
*/
   return new Promise((resolve, reject) => {
      const worker = new Worker(
         new URL('./sim_core.js', import.meta.url), {
            workerData: { idx, CONFIG, state },
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
   /* Conduct checks and prepare state for hand off the sim_core */
   const state = new Object();
   state.pools = JSON.parse(JSON.stringify(CONFIG.parsed.pools));
   importHistory(state);               // Add critical historical data to state
   initializePools(state);             // Add pools: ntpDrift, hashrate, and hScore to state
   initializeResultsStorage(state);    // Set up streams to receive worker returned data

   /* Prepare the worker callback function */
   const limit = pLimit(CONFIG.env.workers);
   const jobs  = Array.from({ length: CONFIG.env.simRounds }, (_, idx) => {
      return { idx , promise: limit( () => runSimCoreInWorker(idx, CONFIG, state)) };
   });

   /* Await each job’s completion (order of resolution is not important) */
   console.log(`[${timeNow()}] Environment checks good, starting sim rounds...\n`);
   for (const { idx, promise } of jobs) {
      try {
         const { results: results, log: log, } = await promise;  // Destructure results from sim_core
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
