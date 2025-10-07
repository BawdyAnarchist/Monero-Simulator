/*
   Conducts the setup, housekeeping, results analysis/summarization, and
   system I/O formatting which surrounds the actual simulation engine. 
*/

import path from 'path';
import { parentPort, workerData } from 'node:worker_threads';
import v8 from 'v8';
import { gzipSync } from 'node:zlib';
import { randomLcg, randomLogNormal, randomExponential } from 'd3-random';
import { runSimulationEngine } from './sim_engine.js';

/* Data objects passed by the worker manager in main */
const { idx, config, state } = workerData;
const { env, sim, parsed, log } = config;
const { pools, blocks, startTip } = state;

/* Custom LOG. Strings are parsed only if the log is activated (speed boost for non-log runs) */
const LOG = { info: [], probe: [], stats: [] };
const info  = (msg) => { if (!log.info)  return; LOG.info.push(msg()); }
const probe = (msg) => { if (!log.probe) return; LOG.probe.push(msg()); }
const stats = (msg) => { if (!log.stats) return; LOG.stats.push(msg()); }

const results = new Object();

function timeNow() {
   return new Date().toLocaleTimeString();
}
function msNow() {
   return new Date().toISOString().slice(11, 23);
}

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

   /* Seed generators once. Declare samplers (prob distributions) to call later (most efficient).
      Uniquely seeding each stoch process sampler, reduces variance between permutations.
      Future improvement - each pool gets its own rng/sampler, especially for blockTimes.      */
   const seed    = parsed.sweeps ? env.seed : env.seed + idx;
   const rngP2P  = randomLcg(seed + 10001);
   const rngP2H  = randomLcg(seed + 20002);
   const rngTx   = randomLcg(seed + 30003);
   const rngExp  = randomLcg(seed + 40004);
   const rngOwdP = randomLcg(seed + 50005);
   const rngOwdH = randomLcg(seed + 60006);

   const logNormalP2P = randomLogNormal.source(rngP2P);
   const logNormalP2H = randomLogNormal.source(rngP2H);
   const logNormalTx  = randomLogNormal.source(rngTx);
   const expFactory   = randomExponential.source(rngExp);

   const baseP2P    = logNormalP2P(pingMu,  sigma);
   const baseP2H    = logNormalP2H(pingMu2, sigma2);
   const baseTxTime = logNormalTx(txMu, sigma);

   /* Call the samplers, with the stats() log integrated for correctness auditing */
   const owdP2P = () => {                        // 1% prob of 2x spike at 50ms P2P
      const value = rngOwdP() < spikeProb(0.01) ? baseP2P() * spikeMult() : baseP2P();
      stats(() => `owdP2P: ${value}`);
      return value;
   };
   const owdP2H = () => {                        // 4% prob of 2x spike at 50ms P2P
      const value = rngOwdH() < spikeProb(0.04) ? baseP2H() * spikeMult() : baseP2H();
      stats(() => `owdP2H: ${value}`);
      return value;
   };
   const transTime = () => {
      const value = baseTxTime();
      stats(() => `transTime: ${value}`);
      return value;
   };
   const blockTime = (lambda) => {
      const value = expFactory(lambda)();
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
      const module = await import(path.resolve(config.root, 'src', strategy.module));
      if (typeof module.setLog  === 'function') module.setLog(info);      // Inject into pool agent
      if (typeof module.setLog2 === 'function') module.setLog2(probe); // Inject into pool agent
      const entryPoint = strategy.entryPoint;
      strategies[strategy.id] = module[entryPoint];  // Populate strategies with id and function
   }
   return strategies;
}

function calculateMetrics(results) {
/*
   Summarize important metrics for the round. Orphan rate, reorg length stats, and selfish miner
   advantage. Pool selection bias is avoided by analyzing the perspective of all pools, then avg/
   stdev over all pools to present aggregated results. Stdev helps identify pool-view divergences.
   Note that this doesnt assess a network of pure selfish miners. Outside current scope.
*/
   /* Honest vs Selfish grouping/HPP matters -> we need to calculate what the honest pools saw */
   let selfishHPP   = 0;
   let selfishIds   = new Set();
   let honestIds    = new Set();
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
      let prevScore    = startTip;
      let latestHead   = startTip;
      let canonical    = 0;
      let selfishCount = 0;
      let orphanCount  = 0;
      let reorgDepth   = 0;
      let reorgList    = [];
      let gammaCount   = 0;   // Track gamma to see what a realistic network might produce
      let forkCount    = 0;

      /* Reorgs detection. Reorgs arent merely the orphan count, but an actual head switch
         Order is crucial -> guaranteed by object creation + integrateStrategy in the sim_engine */
      const scores = Object.entries(p.scores);                // Copy the pool's scores object
      for (const [id, score] of scores) {
         const scoreIsSelfish = selfishIds.has(blocks[id].poolId);

         if (score.isHeadPath) {
            canonical++;                           // Count all canonical blocks excluding orphans
            if (scoreIsSelfish) selfishCount++;    // Count all selfish that are canonical
            latestHead = id;                       // Only used for difficulty assessment (per pool)

            /* The score is canonical, pool is now aligned, but was previously wrong (must reorg) */
            if (id === score.chaintip && reorgDepth > 0) {
               reorgList.push(reorgDepth);         // Track all unique, completed reorg lengths
               reorgDepth = 0;
            }
         } else {
            if (!scoreIsSelfish) orphanCount++;       // We don't count selfish orphans as genuine
            if (id === score.chaintip) reorgDepth++;  // Pool thought it was headPath, but it wasnt
         }

         /* Compute gamma */
         if (blocks[id].height === blocks[prevScore].height) {     // Contention for the head
            const prevIsSelfish = selfishIds.has(blocks[prevScore].poolId);
            if (scoreIsSelfish || prevIsSelfish) forkCount++;      // involving selfish pool
            if (prevIsSelfish) gammaCount++;                       // Pool saw/mined selfish first
         }
         prevScore = id;
      }
      /* Nothing to report. Guard against divide by zero. HH0 means canonical is always >= 1 */
      if (canonical < 2) {
         metrics[p.id] = { orphanRate: 0, reorgP99: 0, reorgMax: 0, selfShares: 0, gamma: 0};
         continue;
      }

      /* Calculate metrics for the pool and add to the metrics object */
      reorgList.sort((a, b) => a - b);
      const orphanRate = orphanCount / (canonical - 1);          // (-1) because HH0 is the startTip
      const reorgMax   = reorgList.at(-1) ?? 0;
      const reorgP99   = reorgList[Math.ceil(reorgList.length * 0.99) - 1] ?? 0;
      const reorg10cnt = reorgList.filter(val => val >= 10).length;  // Rate of 10+ block reorgs
      const reorgRate  = reorg10cnt / blocks[startTip].height - blocks[latestHead].height;
      const selfShares = (selfishCount / (canonical - 1)) - selfishHPP;
      const gamma      = (gammaCount / forkCount) * (p.HPP / (1-selfishHPP)) ?? 0;
      const difficulty = Number(blocks[latestHead].difficulty);  // Cast Num from bigInt
      const diffDiverg = difficulty / (sim.hashrate * 120)       // Divergence to expectation
      metrics[p.id] = { orphanRate, reorgMax, reorgP99, reorgRate, selfShares, gamma, difficulty }
   }
   /* Summarize the metrics from all the pools. Include stdev to detect partitioning or divergence */
   const keys = Object.keys(Object.values(metrics)[0]);
   const summary = {};
   keys.forEach(key => {
     const values = Object.values(metrics).map(m => m[key]);
     const sum    = values.reduce((a, b) => a + b, 0);
     const mean   = sum / values.length;
     const stdev  = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
     summary[key] = { mean, stdev };
     if (key === "gamma") summary[key] = { mean: sum, stdev: 0 };
   });

   if (config.data.metrics) results.metrics = metrics;   // Only save per-pool metrics if flagged
   results.summary = summary;
}

function prepareDataExport(results) {
/* Final data formatting applied here to keep load off of main.js for parallelizable tasks.
   Chunk/streaming not possible, as reorgs imply state uncertainty until exit. I/O is fast anyways.
*/
   results.headers = {};   // Storage object to write the headers later
   const sweepCols = (config.run && Array.isArray(config.run.sweepHeader))
      ? config.run.sweepHeader : [];
   const sweepVals = (config.run && Array.isArray(config.run.sweepPairs))
      ? config.run.sweepPairs.map(p => p.value) : [];

   /* Summarized metrics */
   if (results.summary) {
      const summaryKeys   = Object.keys(results.summary);
      const summaryValues = summaryKeys.flatMap(key => [
         results.summary[key].mean.toFixed(4),
         results.summary[key].stdev.toFixed(4),
      ]);
      results.summary = [idx, ...summaryValues, ...sweepVals].join(',') + '\n';     // Always saved
      results.headers['summary'] =
         ['round', ...summaryKeys.flatMap(k => [k, `${k}_Std`]), ...sweepCols].join(',');

      /* Metrics per pool */
      if (config.data.metrics) {
         const metricFields  = Object.keys(Object.values(results.metrics)[0]);
         const metricsResult = Object.values(pools)
            .filter(p => results.metrics[p.id])
            .map(p => [idx, p.id, ...metricFields.map(k =>
               results.metrics[p.id][k].toFixed(4)), ...sweepVals].join(','))
            .join('\n') + '\n';
         results.metrics = metricsResult;
         results.headers['metrics'] = ['idx', 'poolId', ...metricFields, ...sweepCols].join(',');
      }
   }

   /* Pool scores */
   if (config.data.scores) {
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
   }

   /* Blocks */
   if (config.data.blocks) {
      const blockFields   = Object.keys(blocks[startTip]);
      const blocksResults = Object.values(blocks)
         .filter(b => b.height > blocks[startTip].height)         // Filter out historical blocks
         .map(b => [idx, ...blockFields.map(k => b[k])].join(','))
         .join('\n') + '\n';
      results.blocks = gzipSync(Buffer.from(blocksResults));
      results.headers['blocks'] = ['idx', ...blockFields].join(',');
   }

   /* Format the log buffers */
   LOG.info  = LOG.info.length  ? LOG.info.join('\n')  + '\n' : '';
   LOG.probe = LOG.probe.length ? LOG.probe.join('\n') + '\n' : '';
   LOG.stats = LOG.stats.length ? LOG.stats.join('\n') + '\n' : '';
}

function exitOrchestrationWorker(exit_code, results) {
/* Unified exit and message handling, both success and error */
   if (has_exited) return;   // Prevent any possibility of a double-call (unlikely but defended)
   has_exited = true;

   if (exit_code === 0) {    // Report back the total heap (RAM) so users can tune env as needed.
      const { used_heap_size } = v8.getHeapStatistics();
      console.log(`[${timeNow()}] Round ${idx.toString().padStart(3, '0')} ` +
         `completed with heap size: ${(used_heap_size/1_048_576).toFixed(1)} MB`);
   }
   prepareDataExport(results);  // Final formatting of the data and logs
   parentPort.postMessage(
      { results: results, log: LOG },
      [ results.blocks?.buffer, results.scores?.buffer ].filter(Boolean)  // No buffer if null
   );
   setImmediate(() => process.exit(exit_code));
}

async function orchestrateRound() {
/* Main orchestration flow and entry point for the worker */ 
   console.log(`[${timeNow()}] Running round: ${idx.toString().padStart(3, '0')}...`);
   info(() => `idx: ${config.run.sweepId} ${JSON.stringify(config.run.sweepPerm, null, 1)}`);

   /* Setup the stochestic model and plugin modules */
   const simNoise   = makeNoiseFunctions();
   const strategies = await makeStrategiesFunctions();

   /* Finally. The actual core of the simulation */
   runSimulationEngine({ sim, state, LOG: {info, probe, stats}, simNoise, strategies });

   /* Calculate and format inline, with objects loaded, and while inside a parallelized worker */
   calculateMetrics(results);

   exitOrchestrationWorker(0, results);
}

// Activate crash handling so that we always get logs and available data returned to main
let has_exited = false;                                              // Global exit call guard
process.on('unhandledRejection', (reason) => {
   info(() => `unhandledRejection: ${reason?.stack || String(reason)}`);
   console.error('unhandledRejection:', reason?.stack || reason);
   exitOrchestrationWorker(1, results);
});
process.on('uncaughtException', (err) => {
   info(() => `uncaughtException: ${err?.stack || String(err)}`);
   console.error('uncaughtException:', err?.stack || err);
   exitOrchestrationWorker(1, results);
});

orchestrateRound();
