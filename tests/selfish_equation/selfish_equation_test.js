/*
   The equation and conditions of the selfish agent are nuanced, and difficult to verify by simply data checking.
   There's 9 combos of selfish actions, and maybe another 10 relevant chain conditions they could encounter.

   This script is for checking the equation's veracity based on direct input setup. The executeSelfishStrategy()
   in this script, is a trimmed copy of the original. The csv import, formatting, etc was AI generated.
   The actual spreadsheet was hand written, and hand checked against the outputs of this script.
*/

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// CSV location
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, 'selfish_equation_setup.csv');

// ["run"|"all"|<number>]
const outputMode = "run";
//const outputMode = 10; 

function executeSelfishStrategy(activeEvent, p, blocks, newTip, commonAncestor, maxTip, results, tc) {

   const retortPolicy  = p.config.policy.retortPolicy;  // Silent vs equal-fork vs keep-lead
   const kThresh       = p.config.policy.kThresh;       // Key inflection point after gaining a lead

   let selfTip, honTip, honAdded = 0;
   if (activeEvent.action === 'RECV_OWN') {
      selfTip        = newTip;
      honTip         = p.honTip;
      commonAncestor = honTip;     // Ancestor walk *almost* always begins at the stored p.honTip.
      while (!p.scores[commonAncestor].isHeadPath) commonAncestor = blocks[commonAncestor].prevId;

      /* Edge case: Genuine overlapping blockTime by selfish -> The real ancestor will be prevId */
      if (p.scores[honTip]?.isHeadPath && blocks[selfTip].height === blocks[honTip].height)
         commonAncestor = blocks[honTip].prevId;

      // REMOVED FOR TESTING (not relevant to the equation)
      //results.chaintip  = newTip;                     // Might as well set some of the results now
      //results.timestamp = scores[newTip].localTime;

   } else {
      /* maxTip null means there's no verified honTip extension. Keep p.chaintip, skip analysis */
      if (!maxTip[1]) {
         //results.chaintip = p.chaintip;  // REMOVED FOR TESTING (not relevant to the equation)
         return;
      }
      honTip         = maxTip[1];
      selfTip        = p.chaintip;
      honAdded       = blocks[honTip].height - blocks[p.honTip].height;
      //results.honTip = honTip;  // REMOVED FOR TESTING (not relevant to the equation)
   }

   /* Calculate lengths of the honest vs selfish branches */
   const ancestorHeight = blocks[commonAncestor].height;
   const honLength      = blocks[honTip].height - ancestorHeight;
   const selfLength     = blocks[selfTip].height - ancestorHeight;
   const kNew           = selfLength - honLength;
   const zeroPrimeBump  = (selfLength > 1 && kNew === 1 && activeEvent.action === 'RECV_OWN') ? 2 : 1;

   /* Core of the generalized SM logic. For rationale and details see: docs/SELFISH_TUNING.md */
   const abandonThresh = (honLength) * (Math.min(0, kThresh) - kNew);
   const claimThresh   = (honLength) * (Math.max(0, kThresh) - kNew + zeroPrimeBump);
   const retortCount   = Math.min(retortPolicy * honAdded, honAdded + 1);

   console.log(`${tc.testId}: abandon: ${abandonThresh} claim: ${claimThresh} retortCnt: ${retortCount} ` + 
            `sL: ${selfLength} hL: ${honLength} k: ${kNew} zpB: ${zeroPrimeBump} anc: ${commonAncestor}`);
}

/*
   NOTES ON THE OBJECTS SETUP.
   The structs created from the csv have the form below

   p = {
      id: P0,
      scores: {see below},
      chaintip,
      altTip,
      config: {
         policy: { kThresh: 0, retortPolicy: 0 }
      }
   };
   
   activeEvent = {  // Only create activeEvent object for Description = activeEvent. 
      simClock 
      poolId: P0,   // Always P0, we're looking at solely P0 perspective
      action:       // 'RECV_OWN' for poolId = P0, 'RECV_OTHER' for all else
      newTip,
   }
   
   p.scores[blockId] =  {  // Example
      simClock
      isHeadPath
      chaintip
   }
   
   blocks[blockId] = {
      simClock,
      height,
      poolId,
      prevId,
   }  
*/


function toNum(v) {
   return v === undefined || v === '' ? undefined : Number(v);
}

function toStr(v) {
   return v === undefined || v === '' ? undefined : String(v);
}

function toBool(v) {
   if (v === undefined || v === '') return undefined;
   if (v === 'true') return true;
   if (v === 'false') return false;
   return undefined;
}

async function parseCSV(filePath) {
   const raw = await fs.readFile(filePath, 'utf8');
   const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
   if (lines.length < 2) return [];

   const header = lines[0].split(',').map(h => h.trim());
   const rows = [];

   for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const row = {};
      for (let j = 0; j < header.length; j++) {
         row[header[j]] = cols[j] === undefined ? '' : cols[j];
      }
      rows.push(row);
   }
   return rows;
}

function buildTestCases(rows) {
   const byId = new Map();

   // Group rows by testId
   for (const r of rows) {
      const id = toNum(r.testId);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(r);
   }

   const testCases = [];

   for (const [testId, group] of byId.entries()) {
      // Sort by simClock ascending
      group.sort((a, b) => toNum(a.simClock) - toNum(b.simClock));

      const blocks = {};
      const pScores = {};
      let activeRow = null;

      for (const r of group) {
         const desc = toStr(r.Description);
         const blockID = toStr(r.blockID);

         if (desc === 'history') {
            if (blockID) {
               blocks[blockID] = {
                  simClock: toNum(r.simClock),
                  height: toNum(r.height),
                  poolId: toStr(r.poolId),
                  prevId: toStr(r.prevId),
               };
            }
            const isHeadPath = toBool(r.isHeadPath);
            if (blockID && isHeadPath !== undefined) {
               pScores[blockID] = {
                  simClock: toNum(r.simClock),
                  isHeadPath: isHeadPath,
                  chaintip: toStr(r['sc.chaintip']),
               };
            }
         }

         if (desc === 'activeEvent') {
            activeRow = r;
            if (blockID) {
               blocks[blockID] = {
                  simClock: toNum(r.simClock),
                  height: toNum(r.height),
                  poolId: toStr(r.poolId),
                  prevId: toStr(r.prevId),
               };
            }
         }
      }

      if (!activeRow) continue;

      const p = {
         id: 'P0',
         scores: pScores,
         chaintip: toStr(activeRow['p.chaintip']),
         honTip: toStr(activeRow['p.honTip']),
         config: {
            policy: {
               kThresh: toNum(activeRow['kT']) ?? 0,
               retortPolicy: toNum(activeRow['rP']) ?? 0,
            },
         },
      };

      const activeEvent = {
         simClock: toNum(activeRow.simClock),
         poolId: 'P0',
         action: toStr(activeRow.poolId) === 'P0' ? 'RECV_OWN' : 'RECV_OTHER',
         newTip: toStr(activeRow.newTip) ?? toStr(activeRow.blockID),
      };

      // maxTip: force index 0 to "0000" (visually irrelevant), index 1 is honest tip from CSV
      const maxTip = ['0000', toStr(activeRow.maxTip)];

      const results = {};

      testCases.push({
         testId,
         p,
         activeEvent,
         blocks,
         maxTip,
         results,
      });
   }

   testCases.sort((a, b) => a.testId - b.testId);
   return testCases;
}

function printConstructedObjects(tc) {
   console.log(`--- Constructed objects for testId ${tc.testId} ---`);
   console.log('p =', JSON.stringify(tc.p, null, 2));
   console.log('activeEvent =', JSON.stringify(tc.activeEvent, null, 2));
   console.log('maxTip =', JSON.stringify(tc.maxTip, null, 2));
   console.log('results =', JSON.stringify(tc.results, null, 2));
   console.log('blocks =', JSON.stringify(tc.blocks, null, 2));
}

async function main() {
   const rows = await parseCSV(CSV_PATH);
   const testCases = buildTestCases(rows);

   if (outputMode === 'all') {
      for (const tc of testCases) {
         printConstructedObjects(tc);
      }
      return;
   }

   if (typeof outputMode === 'number') {
      const tc = testCases.find(t => t.testId === outputMode);
      if (!tc) {
         console.log(`No testId ${outputMode} found in CSV.`);
         return;
      }
      printConstructedObjects(tc);
      return;
   }

   if (outputMode === 'run') {
      for (const tc of testCases) {
         const p = tc.p;
         const blocks = tc.blocks;
         const activeEvent = tc.activeEvent;
         const maxTip = tc.maxTip;
         const results = tc.results;

         const commonAncestor = (() => {
            let id = activeEvent.newTip;
            while (p.scores[id]?.isHeadPath !== true) {
               if (!blocks[id]) throw new Error(`Unknown block ${id} while walking ancestor`);
               id = blocks[id].prevId;
            }
            return id;
         })();

         executeSelfishStrategy(
            activeEvent,
            p,
            blocks,
            activeEvent.newTip,
            commonAncestor,
            maxTip,
            results,
            tc,
         );
      }
      return;
   }

   console.log('Invalid outputMode. Use "run", "all", or a specific numeric testId.');
}

main();
