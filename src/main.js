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
import { cpus } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import pLimit from 'p-limit';
import {randomLcg, randomNormal } from 'd3-random';
import './config_init.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJ_ROOT  = path.resolve(__dirname, '..');

/* Logging System */
let LOG = new Object();
LOG.ERR   = path.join(__dirname, '../logs/main_error.log');
LOG.INFO  = process.env.NODE_DEBUG?.includes('info')  && path.join(__dirname, '../logs/info.log')
LOG.PROBE = process.env.NODE_DEBUG?.includes('probe') && path.join(__dirname, '../logs/probe.log')
LOG.STATS = process.env.NODE_DEBUG?.includes('stats') && path.join(__dirname, '../logs/stats.log')

/* Initialization and Setup */
const HISTORY    = path.join(PROJ_ROOT, 'config/difficulty_bootstrap.csv');
const MANIFEST   = JSON.parse(fs.readFileSync(path.join(
                              PROJ_ROOT, 'config/strategy_manifest.json'),'utf8'));
const POOLS      = JSON.parse(fs.readFileSync(path.join(
                              PROJ_ROOT, 'config/pools.json'), 'utf8'),
                             (k, v) => (k.startsWith('Comment') ? undefined : v));

/* Define all .env constants here, so we can check them (not null) */
const SIM_DEPTH  = Number(process.env.SIM_DEPTH);
const SIM_ROUNDS = Number(process.env.SIM_ROUNDS);
const WORKERS    = Number(process.env.WORKERS);
const WORKER_RAM = Number(process.env.WORKER_RAM);   // Max RAM usage per-worker

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
let   RESULTS_BLOCKS, RESULTS_SCORES, RESULTS_METRICS;
const RESULTS_DIR   = path.join(PROJ_ROOT, 'data/');
const CHUNK_SIZE    = 8 * 1024 *1024;  //8MB chunks
let   blockStream   = null;            //lol
let   scoreStream   = null;
let   metricStream  = null;
let   blockFields   = [];
let   scoreFields   = [];
const blockBuffer   = [];
const scoreBuffer   = [];
const metricsBuffer = [];


// -----------------------------------------------------------------------------
// SECTION 2: GENERIC HOUSEKEEPING HELPERS
// -----------------------------------------------------------------------------

function dateNow() {
   return new Date().toLocaleString();
}
function timeNow() {
   return new Date().toLocaleTimeString();
}

async function conductChecks(pools) {
   /* Checks when running with logging */
   if (LOG.INFO || LOG.PROBE || LOG.STATS) {
      if (SIM_ROUNDS > 1)
         throw new Error('Log mode enabled, dont run multiple rounds in .env');
      if (SIM_DEPTH > 1000)
         console.warn('WARNING: Log mode enabled. Recommend SIM_DEPTH < 1000 to limit file size.');
   }

   /* Check for required simulation files */
   if (!fs.existsSync(HISTORY)) throw new Error(`Missing history file: ${HISTORY}`);

   /* Check for presence of critical environment variables */
   const envVars = [ 'SIM_DEPTH', 'SIM_ROUNDS', 'WORKERS', 'NETWORK_HASHRATE',
      'DIFFICULTY_TARGET_V2', 'DIFFICULTY_WINDOW', 'DIFFICULTY_LAG', 'DIFFICULTY_CUT',
      'NTP_STDEV', 'PING', 'MBPS', 'CV', 'BLOCK_SIZE', 'SEED'];
   for (const v of envVars) {
      if (process.env[v] === undefined || isNaN(parseFloat(process.env[v])))
         throw new Error(`Invalid or missing environment variable: ${v}`);
   }

   /* Verify pool configurations and total hashpower = 100% */
   let totalHPP = 0;
   for (const [poolId, poolConfig] of Object.entries(pools)) {
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

async function initializeResultsStorage(blocks, hBlock, hScore, pools) {
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
   for (const id in pools) poolsOut[id].ntpDrift = pools[id].ntpDrift;
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
   RESULTS_METRICS = path.join(RESULTS_DIR, `${runId}_results_metrics.csv`);
   blockStream  = createGzip();
   scoreStream  = createGzip();
   blockStream.pipe(fs.createWriteStream(RESULTS_BLOCKS,  { flags: 'w' }));
   scoreStream.pipe(fs.createWriteStream(RESULTS_SCORES,  { flags: 'w' }));
   metricStream =   fs.createWriteStream(RESULTS_METRICS, { flags: 'w' });
   blockStream.on( 'error', (err) => { console.error('blockStream error', err); });
   scoreStream.on( 'error', (err) => { console.error('scoreStream error', err); });
   metricStream.on('error', (err) => { console.error('scoreStream error', err); });

   /* Capture field order based on initializeHistory(). Write the headers, and the history */
   blockFields = Object.keys(hBlock);
   scoreFields = Object.keys(hScore);
   const blocksHeader  = ['round', ...blockFields];
   const scoresHeader  = ['round', 'pool', 'blockId', ...scoreFields];
   const metricsHeader = ['round', 'orphanRate', 'stdOR', 'reorgMax', 'stdRM',
                          'reorgP99', 'stdP99', 'selfishBonus', 'stdSB'];
   blockStream.write(blocksHeader.join(',') + '\n');
   scoreStream.write(scoresHeader.join(',') + '\n');
   metricStream.write(metricsHeader.join(',') + '\n');

   /* Write historical blocks (history not included in results_blocks -> avoid duplicated data) */
   const HISTORY_BLOCKS = path.join(RESULTS_DIR, `${runId}_historical_blocks.csv.gz`);
   const historyStream = createGzip();
   historyStream.pipe(fs.createWriteStream(HISTORY_BLOCKS));
   historyStream.write(blocksHeader.join(',') + '\n');
   for (const b of Object.values(blocks)) {
      historyStream.write(['0', ...blockFields.map(k => b[k])].join(',') + '\n');
   }
   historyStream.end();
}

async function recordResultsToCSV(idx, poolsResults, blocksResults, metrics) {
   /* Raw blocks data */
   const blockRows = Object.values(blocksResults)
      .map(b => [idx, ...blockFields.map(k => b[k])].join(',')).join('\n');
   if (blockRows) blockBuffer.push(blockRows);

   /* Raw scores data (all pools) */
   const scoreRows = Object.entries(poolsResults).flatMap(([poolId, poolData]) =>
      Object.entries(poolData.scores).map(([blockId, score]) =>
         [idx, poolId, blockId, ...scoreFields.map(k => k === 'simClock'
            ? score[k].toFixed(7) : score[k])].join(','))).join('\n');
   if (scoreRows) scoreBuffer.push(scoreRows);

   /* Metrics summary (avg/stdev over all of the honest, per-pool metrics) */
   const metricsKeys = ['orphanRate', 'reorgMax', 'reorgP99', 'selfProfit'];
   const summaryValues = metricsKeys.flatMap(key => [
      metrics.summary[key].mean.toFixed(4),
      metrics.summary[key].stdev.toFixed(4),  // std helps detect partitions or inter-pool anomalies
   ]);
   metricsBuffer.push([idx, summaryValues].join(','));

   /* Write the buffer */
   if (blockBuffer.join('\n').length   >= CHUNK_SIZE) await writeToBuffer(blockStream, blockBuffer);
   if (scoreBuffer.join('\n').length   >= CHUNK_SIZE) await writeToBuffer(scoreStream, scoreBuffer);
   if (metricsBuffer.join('\n').length >= CHUNK_SIZE) await writeToBuffer(metricStream, metricsBuffer);
}

async function writeToBuffer(stream, buffer) {
   if (!buffer.length) return;
   const data = buffer.join('\n') + '\n';
   if (!stream.write(data)) await new Promise(res => stream.once('drain', res));
   buffer.length = 0;
}

async function gracefulShutdown() {
   await writeToBuffer(blockStream, blockBuffer);
   await writeToBuffer(scoreStream, scoreBuffer);
   await writeToBuffer(metricStream, metricsBuffer);
   blockStream?.end();
   scoreStream?.end();
   metricStream?.end();
   await Promise.all([
      new Promise(res => blockStream.on('finish', res)),
      new Promise(res => scoreStream.on('finish', res)),
      new Promise(res => metricStream.on('finish', res)),
   ]);
}


// -----------------------------------------------------------------------------
// SECTION 3: SIM INITIALIZATION
// -----------------------------------------------------------------------------

function importHistory() {
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

   return [blocks, hScore, blockId, diffWindows];    // blockId is the chaintip of the historical blocks
}

function initializePools(pools, hScore, startTip) {
/* 
   Pools need initialized with basic parameters. Historic scores are identical between pools
   (we lack that data anyways), but we do simulate ntpDrift for the most recent historical block.
*/
   const normalNtp = randomNormal.source(rng)(0, NTP_STDEV);  // Build once, use in loop
   for (const poolKey in pools) {
      const p            = pools[poolKey];
      const ntpDrift     = normalNtp();
      const score        = { ...hScore, localTime: Math.floor(hScore.localTime + ntpDrift) };
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

function runSimCoreInWorker(idx, pools, blocks, startTip, diffWindows, simDepth) {
/*
   Spawn a worker that runs one, memory isolated simulation round.
   Returns a promise that resolves with a data object (or rejection/error).
*/
   return new Promise((resolve, reject) => {
      const worker = new Worker(
         new URL('./sim_core.js', import.meta.url), {
            workerData: { idx, pools, blocks, startTip, diffWindows, simDepth, LOG },
            resourceLimits: { maxOldGenerationSizeMb: WORKER_RAM },
         }
      );
      let result;
      let errorObj;
      worker.once('message', (data) => { result = data; });
      worker.once('error', (err) => { errorObj = err; });
      worker.once('exit', (code) => {
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
   let pools = JSON.parse(JSON.stringify(POOLS));
   await conductChecks(pools);                      // Check critical files, constants, and functions

   const [blocks, hScore, startTip, diffWindows] = importHistory();
   initializePools(pools, hScore, startTip);                 // Setup ntpDrift, hashrate, and history
   initializeResultsStorage(blocks, blocks[startTip], hScore, pools); // Requires pools/blocks fields

   /* Set thread limit, depth, and prepare the worker call */ 
   const limit    = pLimit(WORKERS || 2);
   const simDepth = blocks[startTip].simClock + (SIM_DEPTH * 3600);
   const jobs = Array.from({ length: SIM_ROUNDS }, (_, idx) => {
      return { idx , promise: limit(() =>
         runSimCoreInWorker(idx, pools, blocks, startTip, diffWindows, simDepth, LOG)) };
   });
   console.log(`[${timeNow()}] Environment checks good, starting sim rounds...\n`);

   /* Await each job’s completion (order of resolution is not important) */
   let completedJobs = 0;
   for (const { idx, promise } of jobs) {
      try {
         const {
            pools:   poolsResults,
            blocks:  blocksResults,
            metrics: metrics,
            LOG:     LOG,
         } = await promise;

         if (++completedJobs === jobs.length)
            console.log(`\n[${timeNow()}] All rounds complete. Waiting on disk...`);
         if (LOG.INFO)  fs.writeFileSync(LOG.INFO,  `INFO GENERATED: ${dateNow()}\n${LOG.info}`);
         if (LOG.PROBE) fs.writeFileSync(LOG.PROBE, `PROBE GENERATED: ${dateNow()}\n${LOG.probe}`);
         if (LOG.STATS) fs.writeFileSync(LOG.STATS, `STATS GENERATED: ${dateNow()}\n${LOG.stats}`);
         await recordResultsToCSV(idx, poolsResults, blocksResults, metrics);
      } catch (error) {
         console.error(`[${timeNow()}] FAILURE on round: ${idx}:`, error.message);
         if (LOG.INFO && error.result?.LOG.info)
            fs.writeFileSync(LOG.INFO, `WORKER ${idx} LOG\n${error.result.info}\n`);
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
