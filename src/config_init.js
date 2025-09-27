/*
   Initializes all configuration. Reads/parses/validates env and config files,
   and exports a single immutable CONFIG object for the entire application.
*/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const PROJ_ROOT   = path.resolve(__dirname, '..');

const CONFIG = {       // Declare the master CONFIG object
   root:   PROJ_ROOT,
   runId:  null,
   sim:    {},
   config: {},
   parsed: {},
   run:    {},
   data:   {},
   log:    {},
};

function initializeEnvironment() {
   /* Copy the env and configs from the samples, but don't overwrite any existing user files  */
   const configFiles = [
      { live: path.join(PROJ_ROOT, '.env'),
         bak: path.join(PROJ_ROOT, 'config', 'default.env')
      },
      { live: path.join(PROJ_ROOT, 'config', 'pools.json'),
         bak: path.join(PROJ_ROOT, 'config', 'pools.json.example')
      },
      { live: path.join(PROJ_ROOT, 'config', 'strategy_manifest.json'),
         bak: path.join(PROJ_ROOT, 'config', 'strategy_manifest.json.example')
      },
      { live: path.join(PROJ_ROOT, 'config', 'difficulty_bootstrap.csv'),
         bak: path.join(PROJ_ROOT, 'config', 'difficulty_bootstrap.csv.sample')
      }
   ];
   for (const file of configFiles) {
      if (!fs.existsSync(file.live)) {                     // Perform copy
         if (fs.existsSync(file.bak)) fs.copyFileSync(file.bak, file.live);
         else throw new Error(`FATAL: ${file.live} not found and no example exists at ${file.bak}`);
      }
      const lines = fs.readFileSync(file.live, 'utf8').split('\n');  // Remove comments
      if (lines.length > 1 && lines[0].startsWith('##') && lines[1].startsWith('##')) {
         const modifiedContent = lines.slice(2).join('\n');
         fs.writeFileSync(file.live, modifiedContent, 'utf8');
      }
   }

   /* Read the environment */
   dotenv.config();
   CONFIG.sim = {
      simDepth:   Number(process.env.SIM_DEPTH),
      simRounds:  isNaN(parseInt(process.env.SIM_ROUNDS))
                ? String(process.env.SIM_ROUNDS)
                : Number(process.env.SIM_ROUNDS),
      workers:    Number(process.env.WORKERS),
      workerRam:  Number(process.env.WORKER_RAM),
      dataMode:   String(process.env.DATA_MODE),
      logMode:    String(process.env.LOG_MODE),
      diffTarget: Number(process.env.DIFFICULTY_TARGET_V2),
      diffWindow: Number(process.env.DIFFICULTY_WINDOW),
      diffLag:    Number(process.env.DIFFICULTY_LAG),
      diffCut:    Number(process.env.DIFFICULTY_CUT),
      hashrate:   Number(process.env.NETWORK_HASHRATE),
      blockSize:  Number(process.env.BLOCK_SIZE),
      seed:       Number(process.env.SEED) >>> 0,
      ping:       Number(process.env.PING),
      cv:         Number(process.env.CV),
      mbps:       Number(process.env.MBPS),
      ntpStdev:   Number(process.env.NTP_STDEV)
   };
}

function populateFilepaths() {
   CONFIG.config = {
      history:  path.join(PROJ_ROOT, 'config/difficulty_bootstrap.csv'),
      pools:    path.join(PROJ_ROOT, 'config/pools.json'),
      manifest: path.join(PROJ_ROOT, 'config/strategy_manifest.json'),
      env:      path.join(PROJ_ROOT, '.env')
   };

   CONFIG.parsed.manifest = JSON.parse(fs.readFileSync(CONFIG.config.manifest, 'utf8'));
   CONFIG.parsed.pools    = JSON.parse(fs.readFileSync(CONFIG.config.pools, 'utf8'),
                            (k, v) => (k.startsWith('Comment') ? undefined : v));

   CONFIG.log = {                        // Presence of CONFIG.log.<file> activates the log
      info:  CONFIG.sim.logMode?.includes('info')  && path.join(PROJ_ROOT, 'logs/info.log'),
      probe: CONFIG.sim.logMode?.includes('probe') && path.join(PROJ_ROOT, 'logs/probe.log'),
      stats: CONFIG.sim.logMode?.includes('stats') && path.join(PROJ_ROOT, 'logs/stats.log'),
      error: path.join(PROJ_ROOT, 'logs/main_error.log')
   };

   /* Each run generates a unique incremented numeric prefix for the outputs in /data  */
   const DATA_DIR = path.join(PROJ_ROOT, 'data/');
   const files    = fs.readdirSync(DATA_DIR);
   const numbers  = files.map(f => f.match(/^(\d+)_/)).filter(Boolean).map(m => +m[1]);
   CONFIG.runId   = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, '0');
   const runId    = CONFIG.runId;
   const mode     = CONFIG.sim.dataMode;

   CONFIG.run = {   // Static run details saved to the data directory (no stream required)  
      history:  path.join(DATA_DIR, `${runId}_historical_blocks.csv`),
      env:      path.join(DATA_DIR, `${runId}_env.txt`),
      pools:    path.join(DATA_DIR, `${runId}_pools.json`),
      manifest: path.join(DATA_DIR, `${runId}_strategy_manifest.json`),
   }

   CONFIG.data = {  // Data streams will be created for all populated filepaths
      summary: path.join(DATA_DIR, `${runId}_results_summary.csv`),
      blocks:  (mode === 'full') && path.join(DATA_DIR, `${runId}_results_blocks.csv.gz`),
      scores:  (mode === 'full') && path.join(DATA_DIR, `${runId}_results_scores.csv.gz`),
      metrics: (mode === 'full' || mode === 'metrics')
                                 && path.join(DATA_DIR, `${runId}_results_metrics.csv`),
   };
}

async function conductChecks() {
/* Pre-run validation checks */

   if (!fs.existsSync(CONFIG.config.history))
      throw new Error(`Missing history file: ${CONFIG.config.history}`);

   if (!['simple', 'metrics', 'full'].includes(CONFIG.sim.dataMode))
      throw new Error('DATA_MODE must be either: "simple", "metrics", or "full"');

   if (typeof CONFIG.sim.simRounds !== 'number'
      && CONFIG.sim.simRounds !== 'sweep' && CONFIG.sim.simRounds !== 'sweeps')
         throw new Error('SIM_ROUNDS must either be an integer, or the string: sweep');

   /* CONFIG.log.error always exists, so it has to be excluded from logMode test/check */
   const nonErrorLogs = Object.entries(CONFIG.log).filter(([k]) => k !== 'error').map(([, v]) => v);
   if (nonErrorLogs.some(Boolean)) {
      for (const log of Object.values(CONFIG.log))
         if (log && fs.existsSync(log)) fs.unlinkSync(log);
      if (CONFIG.sim.simRounds > 1)
         throw new Error('Log mode enabled, dont run multiple rounds in .env');
      if (CONFIG.sim.simDepth > 1000)
         console.warn('WARNING: Log mode enabled. Recommend SIM_DEPTH < 1000 to limit file size.');
   }

   for (const key in CONFIG.sim) {
      if (CONFIG.sim[key] === undefined ||
         (typeof CONFIG.sim[key] === 'number' && isNaN(CONFIG.sim[key])))
            throw new Error(`Invalid or missing environment variable: ${key.toUpperCase()}`);
   }

   let totalHPP = 0;
   for (const [poolId, poolConfig] of Object.entries(CONFIG.parsed.pools)) {
      if (!poolConfig.strategy || !CONFIG.parsed.manifest.find(s => s.id === poolConfig.strategy))
         throw new Error(`Pool '${poolId}' has invalid strategy: '${poolConfig.strategy}'`);
      totalHPP += poolConfig.HPP;
   }
   if (Math.abs(totalHPP - 1.0) > 1e-3)
      throw new Error(`Total pool HPP must sum to 1.0. Current sum is: ${totalHPP}`);

   /* Check that all required strategy modules exist and are functions */
   const strategyChecks = CONFIG.parsed.manifest.map(async (strategy) => {
      const modulePath = path.resolve(__dirname, strategy.module);
      if (!fs.existsSync(modulePath))
         throw new Error(`Module not found for '${strategy.id}': ${modulePath}`);
      const module = await import(modulePath);
      if (typeof module[strategy.entryPoint] !== 'function')
         throw new Error(`EntryPoint '${strategy.entryPoint}' not a function in ${strategy.module}`);

      /* Add a few more checks for the reference implementation (unified agent) */
      if (strategy.module === './plugins/unified_pool_agent.js') {
         if (strategy.config?.policy?.honest === undefined) throw new Error(
            `Strategy Manifest for ${strategy.id} is missing config object: config.policy.honest`);
         if (strategy.config?.scoringFunctions === undefined) throw new Error(
            `Strategy Manifest for ${strategy.id} is missing config object: config.scoringFunctions`);
      }
   });
   await Promise.all(strategyChecks);
}

async function runInitialization() {
   initializeEnvironment();
   populateFilepaths();
   await conductChecks();
   Object.freeze(CONFIG);           // Make it immutable
}

await runInitialization();
export { CONFIG };
