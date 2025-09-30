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
   labels: {},
};

function exitWithError(message) {
  console.error(`\x1b[35m[CONFIG ERROR]\x1b[0m: ${message}\n`);
  process.exit(1);
}

function initializeEnvironment() {
   /* Copy the env and configs from the samples, but don't overwrite any existing user files  */
   const configFiles = [
      { live: path.join(PROJ_ROOT, '.env'),
         bak: path.join(PROJ_ROOT, 'defaults', 'env.example')
      },
      { live: path.join(PROJ_ROOT, 'config',   'pools.json'),
         bak: path.join(PROJ_ROOT, 'defaults', 'pools.json.example')
      },
      { live: path.join(PROJ_ROOT, 'config',   'strategy_manifest.json'),
         bak: path.join(PROJ_ROOT, 'defaults', 'strategy_manifest.json.example')
      },
      { live: path.join(PROJ_ROOT, 'config',   'difficulty.json'),
         bak: path.join(PROJ_ROOT, 'defaults', 'difficulty.json.example')
      },
      { live: path.join(PROJ_ROOT, 'config',   'dynamic_blocks.json'),
         bak: path.join(PROJ_ROOT, 'defaults', 'dynamic_blocks.json.example')
      },
      { live: path.join(PROJ_ROOT, 'config',   'internet.json'),
         bak: path.join(PROJ_ROOT, 'defaults', 'internet.json.example')
      },
      { live: path.join(PROJ_ROOT, 'config',   'difficulty_bootstrap.csv'),
         bak: path.join(PROJ_ROOT, 'defaults', 'difficulty_bootstrap.csv.sample')
      },
      { live: path.join(PROJ_ROOT, 'config',   'sweeps.json'),
         bak: path.join(PROJ_ROOT, 'defaults', 'sweeps.json.example')
      },
   ];
   for (const file of configFiles) {
      if (!fs.existsSync(file.live)) {                     // Perform copy
         if (fs.existsSync(file.bak)) fs.copyFileSync(file.bak, file.live);
         else exitWithError(`FATAL: ${file.live} not found and no example exists at ${file.bak}`);
      }
      const lines = fs.readFileSync(file.live, 'utf8').split('\n');  // Remove comments
      if (lines.length > 1 && lines[0].startsWith('##') && lines[1].startsWith('##')) {
         const modifiedContent = lines.slice(2).join('\n');
         fs.writeFileSync(file.live, modifiedContent, 'utf8');
      }
   }
}

function populateFilepaths() {
   /* Read and populate the environment */
   dotenv.config();
   CONFIG.env = {
      simRounds:  isNaN(parseInt(process.env.SIM_ROUNDS))
                ? String(process.env.SIM_ROUNDS)
                : Number(process.env.SIM_ROUNDS),
      workers:    Number(process.env.WORKERS),
      workerRam:  Number(process.env.WORKER_RAM),
      dataMode:   String(process.env.DATA_MODE),
      logMode:    String(process.env.LOG_MODE),
      seed:       Number(process.env.SEED) >>> 0,
   }

   /* Specify and parse the config json files */
   CONFIG.config = {
      env:        path.join(PROJ_ROOT, '.env'),
      history:    path.join(PROJ_ROOT, 'config/difficulty_bootstrap.csv'),
      difficulty: path.join(PROJ_ROOT, 'config/difficulty.json'),
      dynamic:    path.join(PROJ_ROOT, 'config/dynamic_blocks.json'),
      internet:   path.join(PROJ_ROOT, 'config/internet.json'),
      manifest:   path.join(PROJ_ROOT, 'config/strategy_manifest.json'),
      pools:      path.join(PROJ_ROOT, 'config/pools.json'),
      sweeps:     path.join(PROJ_ROOT, 'config/sweeps.json'),
   }
   CONFIG.parsed = {
      difficulty: JSON.parse(fs.readFileSync(CONFIG.config.difficulty, 'utf8')),
      dynamic:    JSON.parse(fs.readFileSync(CONFIG.config.dynamic, 'utf8')),
      internet:   JSON.parse(fs.readFileSync(CONFIG.config.internet, 'utf8')),
      manifest:   JSON.parse(fs.readFileSync(CONFIG.config.manifest, 'utf8')),
      pools:      JSON.parse(fs.readFileSync(CONFIG.config.pools, 'utf8'),
                     (k, v) => (k.startsWith('Comment') ? undefined : v)),
      sweeps:     isNaN(CONFIG.env.simRounds) && CONFIG.env.simRounds.includes('sweep')
                     && JSON.parse(fs.readFileSync(CONFIG.config.sweeps, 'utf8')),
   }

   // Simulation parameters from parsed JSON files
   CONFIG.sim = {
      depth:      Number(process.env.SIM_DEPTH),  // More appropriately belongs as sim parameter
      diffTarget: Number(CONFIG.parsed.difficulty.DIFFICULTY_TARGET_V2),
      diffWindow: Number(CONFIG.parsed.difficulty.DIFFICULTY_WINDOW),
      diffLag:    Number(CONFIG.parsed.difficulty.DIFFICULTY_LAG),
      diffCut:    Number(CONFIG.parsed.difficulty.DIFFICULTY_CUT),
      hashrate:   Number(CONFIG.parsed.difficulty.NETWORK_HASHRATE),
      blockSize:  Number(CONFIG.parsed.dynamic.BLOCK_SIZE),
      ping:       Number(CONFIG.parsed.internet.PING),
      cv:         Number(CONFIG.parsed.internet.CV),
      mbps:       Number(CONFIG.parsed.internet.MBPS),
      ntpStdev:   Number(CONFIG.parsed.internet.NTP_STDEV)
   };

   CONFIG.log = {                        // Presence of CONFIG.log.<file> activates the log
      info:  CONFIG.env.logMode?.includes('info')  && path.join(PROJ_ROOT, 'logs/info.log'),
      probe: CONFIG.env.logMode?.includes('probe') && path.join(PROJ_ROOT, 'logs/probe.log'),
      stats: CONFIG.env.logMode?.includes('stats') && path.join(PROJ_ROOT, 'logs/stats.log'),
      error: path.join(PROJ_ROOT, 'logs/main_error.log')
   };

   /* Each run generates a unique incremented numeric prefix for the outputs in /data  */
   const DATA_DIR = path.join(PROJ_ROOT, 'data/');
   const files    = fs.readdirSync(DATA_DIR);
   const numbers  = files.map(f => f.match(/^(\d+)_/)).filter(Boolean).map(m => +m[1]);
   CONFIG.runId   = String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(3, '0');
   const runId    = CONFIG.runId;
   const mode     = CONFIG.env.dataMode;

   CONFIG.run = {  // Additional run details. No sweeps -> null (dont append permutation headers)
      history:     path.join(DATA_DIR, `${runId}_historical_blocks.csv`),
      snapshot:    path.join(DATA_DIR, `${runId}_config_snapshot.json`),
      sweepId:     null,
      sweepHeader: [],
      sweepPairs:  [],
      sweepPerm:   {},
      labelRule: {
         difficulty:  0,
         dynamic:     0,
         internet:    0,
         pools:       1,
         strategies: {
            config: {
               scoring:  1,
               policy:   0,
            }
         }
      }
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
      exitWithError(`Missing history file: ${CONFIG.config.history}`);

   if (!['simple', 'metrics', 'full'].includes(CONFIG.env.dataMode))
      exitWithError('DATA_MODE must be either: "simple", "metrics", or "full"');

   if (['full'].includes(CONFIG.env.dataMode) && CONFIG.parsed.sweeps) console.warn(
      '\x1b[33m[WARNING]\x1b[0m: Sweeps are enabled with DATA_MODE=full. Sweeps can multiply quickly\n');

   if (typeof CONFIG.env.simRounds !== 'number'
      && CONFIG.env.simRounds !== 'sweep' && CONFIG.env.simRounds !== 'sweeps')
         exitWithError('SIM_ROUNDS must either be an integer, or the string: sweep');

   /* CONFIG.log.error always exists, so it has to be excluded from logMode test/check */
   const nonErrorLogs = Object.entries(CONFIG.log).filter(([k]) => k !== 'error').map(([, v]) => v);
   if (nonErrorLogs.some(Boolean)) {
      for (const log of Object.values(CONFIG.log))
         if (log && fs.existsSync(log)) fs.unlinkSync(log);  // For new logs, delete old ones first
      if (CONFIG.sim.depth > 1000) console.warn(
         '\x1b[33m[WARNING]\x1b[0m: Log mode enabled. Recommend SIM_DEPTH < 1000 to limit file size\n');
   }

   for (const key in CONFIG.env) {
      if (CONFIG.env[key] === undefined ||
         (typeof CONFIG.env[key] === 'number' && isNaN(CONFIG.env[key])))
            exitWithError(`Invalid or missing environment variable: ${key.toUpperCase()}`);
   }

   for (const key in CONFIG.sim) {
      if (CONFIG.sim[key] === undefined || (typeof CONFIG.sim[key] !== 'number'))
         exitWithError(`Invalid or missing configuration variable: ${key.toUpperCase()}`);
   }

   let totalHPP = 0;
   for (const [poolId, poolConfig] of Object.entries(CONFIG.parsed.pools)) {
      if (!poolConfig.strategy || !CONFIG.parsed.manifest.find(s => s.id === poolConfig.strategy))
         exitWithError(`Pool '${poolId}' has invalid strategy: '${poolConfig.strategy}'`);
      totalHPP += poolConfig.HPP;
   }
   if (Math.abs(totalHPP - 1.0) > 1e-3)
      exitWithError(`Total pool HPP must sum to 1.0. Current sum is: ${totalHPP.toFixed(4)}`);

   /* Check that all required strategy modules exist and are functions */
   const strategyChecks = CONFIG.parsed.manifest.map(async (strategy) => {
      const modulePath = path.resolve(__dirname, strategy.module);
      if (!fs.existsSync(modulePath))
         exitWithError(`Module not found for '${strategy.id}': ${modulePath}`);
      const module = await import(modulePath);
      if (typeof module[strategy.entryPoint] !== 'function')
         exitWithError(`EntryPoint '${strategy.entryPoint}' not a function in ${strategy.module}`);

      /* Add a few more checks for the reference implementation (unified agent) */
      if (strategy.module === './plugins/unified_pool_agent.js') {
         if (strategy.config?.policy?.honest === undefined) exitWithError(
            `Strategy Manifest for ${strategy.id} is missing config object: config.policy.honest`);
         if (strategy.config?.scoring === undefined) exitWithError(
            `Strategy Manifest for ${strategy.id} is missing config object: config.scoring`);
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
