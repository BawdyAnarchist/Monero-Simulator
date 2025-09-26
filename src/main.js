////////////////////////////////////////////
//  MONERO  POW  SIMULATION  COORDINATOR  // 
////////////////////////////////////////////

// -----------------------------------------------------------------------------
// SECTION 1: IMPORTS, CONSTANTS, GLOBALS
// -----------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import pLimit from 'p-limit';
import {randomLcg, randomNormal } from 'd3-random';
import './config_init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJ_ROOT  = path.resolve(__dirname, '..');

/* Logging System */
let LOG = new Object();
LOG.ERR   = path.join(__dirname, '../logs/main_error.log');
LOG.INFO  = process.env.LOG_MODE?.includes('info')  && path.join(__dirname, '../logs/info.log')
LOG.PROBE = process.env.LOG_MODE?.includes('probe') && path.join(__dirname, '../logs/probe.log')
LOG.STATS = process.env.LOG_MODE?.includes('stats') && path.join(__dirname, '../logs/stats.log')

/* Initialization and Setup */
const HISTORY    = path.join(PROJ_ROOT, 'config/difficulty_bootstrap.csv');
const MANIFEST   = JSON.parse(fs.readFileSync(path.join(
                              PROJ_ROOT, 'config/strategy_manifest.json'),'utf8'));
const POOLS      = JSON.parse(fs.readFileSync(path.join(
                              PROJ_ROOT, 'config/pools.json'), 'utf8'),
                             (k, v) => (k.startsWith('Comment') ? undefined : v));

/* Define all .env constants here, so we can check them (not null) */
const SIM_DEPTH  = Number(process.env.SIM_DEPTH);
const SIM_ROUNDS = process.env.SIM_ROUNDS;
const WORKERS    = Number(process.env.WORKERS);
const WORKER_RAM = Number(process.env.WORKER_RAM);   // Max RAM usage per-worker
const DATA_MODE  = String(process.env.DATA_MODE);

const DIFFICULTY_TARGET_V2 = Number(process.env.DIFFICULTY_TARGET_V2);
const DIFFICULTY_WINDOW = Number(process.env.DIFFICULTY_WINDOW);
const DIFFICULTY_LAG = Number(process.env.DIFFICULTY_LAG);
const DIFFICULTY_CUT = Number(process.env.DIFFICULTY_CUT);
const NETWORK_HASHRATE = Number(process.env.NETWORK_HASHRATE);

const NTP_STDEV  = Number(process.env.NTP_STDEV);
const PING       = Number(process.env.PING);
const MBPS       = Number(process.env.MBPS);
const CV         = Number(process.env.CV);
const BLOCK_SIZE = Number(process.env.BLOCK_SIZE);
const SEED       = Number(process.env.SEED) >>> 0;
const rng        = randomLcg(SEED);

/* Results files and recording tools */
let   RESULTS_BLOCKS, RESULTS_SCORES, RESULTS_SUMMARY;
const RESULTS_DIR   = path.join(PROJ_ROOT, 'data/');
let   blockStream   = null;            //lol
let   scoreStream   = null;
let   summaryStream = null;
let   headerWritten = false


// -----------------------------------------------------------------------------
// SECTION 2: GENERIC HOUSEKEEPING HELPERS
// -----------------------------------------------------------------------------

function dateNow() {
   return new Date().toLocaleString();
}
function timeNow() {
   return new Date().toLocaleTimeString();
}

async function conductChecks(state) {
   /* Check for required simulation files */
   if (!fs.existsSync(HISTORY)) throw new Error(`Missing history file: ${HISTORY}`);

   /* Verify correctness of the DATA_MODE and SIM_ROUNDS */
   if (DATA_MODE !== 'simple' && DATA_MODE !== 'metrics' && DATA_MODE !== 'full')
      throw new Error('DATA_MODE must be either: "simple", "metrics", or "full"');
   if (isNaN(parseInt(SIM_ROUNDS)) && SIM_ROUNDS !== 'sweep' && SIM_ROUNDS !== 'sweeps')
      throw new Error('SIM_ROUNDS must either be an integer, or the string: sweep');

   /* Checks when running with logging */
   if (LOG.INFO || LOG.PROBE || LOG.STATS) {
      for (const log of Object.values(LOG))
         if (log && fs.existsSync(log)) fs.unlinkSync(log);     // Delete previous logs
      if (SIM_ROUNDS > 1)
         throw new Error('Log mode enabled, dont run multiple rounds in .env');
      if (SIM_DEPTH > 1000)
         console.warn('WARNING: Log mode enabled. Recommend SIM_DEPTH < 1000 to limit file size.');
   }

   /* Check for presence of critical integer environment variables */
   const envIntegers = [
      'SIM_DEPTH', 'WORKERS', 'WORKER_RAM', 'NETWORK_HASHRATE', 'BLOCK_SIZE',
      'DIFFICULTY_TARGET_V2', 'DIFFICULTY_WINDOW', 'DIFFICULTY_LAG', 'DIFFICULTY_CUT',
      'SEED', 'PING', 'CV', 'MBPS', 'NTP_STDEV',
   ];
   for (const v of envIntegers) {
      if (process.env[v] === undefined || isNaN(parseFloat(process.env[v])))
         throw new Error(`Invalid or missing environment variable: ${v}`);
   }

   /* Verify pool configurations and total hashpower = 100% */
   let totalHPP = 0;
   for (const [poolId, poolConfig] of Object.entries(state.pools)) {
      if (!poolConfig.strategy || !MANIFEST.find(s => s.id === poolConfig.strategy))
         throw new Error(`Pool '${poolId}' has invalid strategy: '${poolConfig.strategy}'`);
      totalHPP += poolConfig.HPP;
   }
   if (Math.abs(totalHPP - 1.0) > 1e-3) {
      throw new Error(`Total pool HPP must sum to 1.0, but is ${totalHPP}`);
   }

   /* Verify all strategy modules and their entry points */
   const strategyChecks = MANIFEST.map(async (strategy) => {
      const modulePath  = path.resolve(__dirname, strategy.module);
      if (!fs.existsSync(modulePath))
         throw new Error(`Module not found for '${strategy.id}': ${modulePath}`);
      const module = await import(modulePath);
      if (typeof module[strategy.entryPoint] !== 'function')
         throw new Error(`EntryPoint '${strategy.entryPoint}' not a function in ${strategy.module}`);

      /* unified_pool_agent.js is 1st class citizen, even though technically it's a pluggable module */
      if (strategy.module === './plugins/unified_pool_agent.js') {
         if (strategy.config?.policy?.honest === undefined) throw new Error(
            `Strategy Manifest for ${strategy.id} is missing config object: config.policy.honest`);
         if (strategy.config?.scoringFunctions === undefined) throw new Error(
            `Strategy Manifest for ${strategy.id} is missing config object: config.scoringFunctions`);
      }
   });
   await Promise.all(strategyChecks);
} 

async function initializeResultsStorage(state) {
/*
   Results are stored in /data, with a unique prefix (001, 002, ...).
   This includes the sim results and the env files required for a reproducible run.
*/
   const files   = fs.readdirSync(RESULTS_DIR);
   const numbers = files.map(f => f.match(/^(\d+)_/)).filter(Boolean).map(m => +m[1]);
   const num     = (numbers.length ? Math.max(...numbers) : 0) + 1;
   const runId   = String(num).padStart(3, '0');

   /* Copy the verbatim .env, manifest, and pools (with NTP adjustments) to data/results */
   const poolsOut = JSON.parse(JSON.stringify(POOLS));   // original template
   for (const id in state.pools) poolsOut[id].ntpDrift = state.pools[id].ntpDrift;
   fs.writeFileSync(
      path.join(RESULTS_DIR, `${runId}_pools.json`),
      JSON.stringify(poolsOut, null, 2));
   fs.copyFileSync(
      path.resolve(__dirname, '../.env'),
      path.join(RESULTS_DIR, `${runId}_env.txt`));
   fs.writeFileSync(
      path.join(RESULTS_DIR, `${runId}_strategy_manifest.json`),
      JSON.stringify(MANIFEST, null, 2));

   /* Opens streams for data output */
   RESULTS_BLOCKS  = path.join(RESULTS_DIR, `${runId}_results_blocks.csv.gz`);
   RESULTS_SCORES  = path.join(RESULTS_DIR, `${runId}_results_scores.csv.gz`);
   RESULTS_SUMMARY = path.join(RESULTS_DIR, `${runId}_results_summary.csv`);
   blockStream     = fs.createWriteStream(RESULTS_BLOCKS,  { flags: 'w' });
   scoreStream     = fs.createWriteStream(RESULTS_SCORES,  { flags: 'w' });
   summaryStream   = fs.createWriteStream(RESULTS_SUMMARY, { flags: 'w' });
   blockStream.on('error', (err) => { console.error('blockStream error', err); });
   scoreStream.on('error', (err) => { console.error('scoreStream error', err); });
   summaryStream.on('error', (err) => { console.error('scoreStream error', err); });

   /* Write historical blocks (history not included in results_blocks -> avoid duplicated data) */
   const blockFields = Object.keys(state.blocks[state.startTip]);
   const HISTORY_BLOCKS = path.join(RESULTS_DIR, `${runId}_historical_blocks.csv.gz`);
   let csv = blockFields.join(',') + '\n';
   for (const b of Object.values(state.blocks))
      csv += blockFields.map(k => b[k]).join(',') + '\n';
   fs.writeFileSync(HISTORY_BLOCKS, gzipSync(Buffer.from(csv)));
}

async function recordResultsToCSV(results, LOG) {
   if (!headerWritten) {
      const blocksHeader  = gzipSync(Buffer.from(results.blocks_header + '\n'));
      const scoresHeader  = gzipSync(Buffer.from(results.scores_header + '\n'));
      const summaryHeader = Buffer.from(results.summary_header + '\n');
      await Promise.all([
         writeBufferToStream(blockStream, blocksHeader),
         writeBufferToStream(scoreStream, scoresHeader),
         writeBufferToStream(summaryStream, summaryHeader),
      ]);
      headerWritten = true;
   }

   await Promise.all([
      writeBufferToStream(blockStream, results.blocks),
      writeBufferToStream(scoreStream, results.scores),
      writeBufferToStream(summaryStream, results.summary),
   ]);

   if (LOG.INFO)  fs.writeFileSync(LOG.INFO,  `INFO GENERATED: ${dateNow()}\n${LOG.info}`);
   if (LOG.PROBE) fs.writeFileSync(LOG.PROBE, `PROBE GENERATED: ${dateNow()}\n${LOG.probe}`);
   if (LOG.STATS) fs.writeFileSync(LOG.STATS, `STATS GENERATED: ${dateNow()}\n${LOG.stats}`);
}

async function writeBufferToStream(stream, buf) {
   /* The check is necessary for efficient chunk queueing/buffer */
   if (!stream.write(buf)) await new Promise(resolve => stream.once('drain', resolve));
}

async function gracefulShutdown() {
   blockStream?.end();
   scoreStream?.end();
   summaryStream?.end();
   await Promise.all([
      new Promise(res => blockStream.on('finish', res)),
      new Promise(res => scoreStream.on('finish', res)),
      new Promise(res => summaryStream.on('finish', res)),
   ]);
}


// -----------------------------------------------------------------------------
// SECTION 3: SIM INITIALIZATION
// -----------------------------------------------------------------------------

function importHistory(state) {
/*
   Populate `blocks` with 735 blocks of history for difficulty adjustment calculation. A
   stateful rolling `diffWindows` avoids a walkback loop via prevId on every new block. 
*/
   const history = fs.readFileSync(HISTORY, 'utf8').split(/\r?\n/).filter(l => l.trim()).slice(1);
   history.sort((a, b) => +a.split(',')[0] - +b.split(',')[0]);
   if (history.length < DIFFICULTY_WINDOW + DIFFICULTY_LAG) throw new Error(
      `${HISTORY} is too short. Needs ${DIFFICULTY_WINDOW + DIFFICULTY_LAG} blocks for bootstrap`);

   let blocks     = Object.create(null);
   let diffWindow = [];
   let blockId, height, timestamp, difficulty, cumulative_difficulty;

   for (const line of history) {
      [height, timestamp, difficulty, cumulative_difficulty] = line.split(',');
      blockId = `${+height}_HH0`;
      const newBlock = {
         simClock:      +timestamp,             // "True" Unix date the moment block was found by pool 
         height:        +height,
         pool:          "HH0",
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
   let diffWindows      = Object.create(null);
   diffWindows[blockId] = diffWindow;  
   if (diffWindow.length > DIFFICULTY_WINDOW + DIFFICULTY_LAG)
      diffWindow = diffWindow.slice(-(DIFFICULTY_WINDOW + DIFFICULTY_LAG));

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
   const normalNtp = randomNormal.source(rng)(0, NTP_STDEV);  // Build once, use in loop
   const startTip  = state.startTip;
   for (const poolKey in state.pools) {
      const p            = state.pools[poolKey];
      const ntpDrift     = normalNtp();
      const score        = { ...state.hScore,
                                localTime: Math.floor(state.hScore.localTime + ntpDrift) };
      p.id               = poolKey;                  // Enrich with id=Key for simplicity later
      p.ntpDrift         = ntpDrift;                 // Persistent ntp drift
      p.hashrate         = p.HPP * NETWORK_HASHRATE; // hashrate based on hashpower percentage
      p.chaintip         = startTip;                 // Last guaranteed historical common ancestor
      p.altTip           = null;                     // For selfish pools to track honest chaintip
      p.scores           = Object.create(null);
      p.scores[startTip] = score;                    // Apply score to last historical block
      p.requestIds       = new Set();                // Missing blocks requested from the network
      p.unscored         = new Map();                // Unscored blocks waiting on ancestor score(s)
      p.config = MANIFEST.find(s => s.id === p.strategy).config;  // Save strategy manifest config
   }
}


// -----------------------------------------------------------------------------
// SECTION 4: MAIN, CONTROL MANAGEMENT
// -----------------------------------------------------------------------------

function runSimCoreInWorker(idx, meta, state, LOG) {
/*
   Spawn a worker that runs one, memory isolated simulation round.
   Returns a promise that resolves with a data object (or rejection/error).
*/
   return new Promise((resolve, reject) => {
      const worker = new Worker(
         new URL('./sim_core.js', import.meta.url), {
            workerData: { idx, meta, state, LOG },
            resourceLimits: { maxOldGenerationSizeMb: WORKER_RAM },
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
   const state   = new Object();
   state.pools   = JSON.parse(JSON.stringify(POOLS));
   await conductChecks(state);         // Check critical files, constants, and functions
   importHistory(state);               // Add critical historical data to state
   initializePools(state);             // Add pools: ntpDrift, hashrate, and hScore to state
   initializeResultsStorage(state);    // Set up streams to receive worker returned data

   /* Declare the meta parameters of each sim_round */
   const meta    = new Object();
   meta.dataMode = DATA_MODE;
   meta.simDepth = state.blocks[state.startTip].simClock + (SIM_DEPTH * 3600);

   /* Prepare the worker callback function */
   const limit = pLimit(WORKERS);
   const jobs  = Array.from({ length: SIM_ROUNDS }, (_, idx) => {
      return { idx , promise: limit( () => runSimCoreInWorker(idx, meta, state, LOG)) };
   });

   /* Await each job’s completion (order of resolution is not important) */
   console.log(`[${timeNow()}] Environment checks good, starting sim rounds...\n`);
   for (const { idx, promise } of jobs) {
      try {
         const { results: results, LOG: LOG, } = await promise;  // Destructure results from sim_core
         await recordResultsToCSV(results, LOG);                 // Record results
      } catch (error) {
         console.error(`[${timeNow()}] FAILURE on round: ${idx}:`, error.message);
         if (LOG.INFO && error.result?.LOG?.info)
            fs.writeFileSync(LOG.INFO, `WORKER ${idx} LOG\n${error.result.LOG.info}\n`);
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
   fs.appendFileSync(LOG.ERR, errorMsg);
   process.exit(1);
});
