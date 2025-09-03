// src/config.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const PROJ_ROOT   = path.resolve(__dirname, '..');
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
   if (!fs.existsSync(file.live)) {
      if (fs.existsSync(file.bak)) {
         fs.copyFileSync(file.bak, file.live);
      } else {
         throw new Error(`[INIT] FATAL: ${file.live} not found and no example exists at ${file.bak}`);
      }
   }
}
dotenv.config();
