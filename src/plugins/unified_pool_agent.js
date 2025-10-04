/*
   Strategy modules isolate a pool's decision making process from the functionally-oriented
   sim_engine. Meaning that core logic for the behavior of any given pool, must be simulated here.
   Checking for branch/head validity, requesting missing blocks, determining if a received block
   links ancestors that were received out-of-order, general and robust ability to reorganize,
   determining whether or not to broadcast a block, and in some cases, timestamp manipulation.
*/
/*
   This strategy is a robustly generalized simulation of multiple pool behaviors:
     - Honest baseline reference (Monero's current PoW)
     - Honest strategies that manipulate difficulty scores (highly extensible/configurable)
     - A range of selfish strategies (also highly configurable)

   Generalizing and combining honest and selfish strategies, should make it easier to test
   selfish response to countermeasures. Toggle/specify pool behavior in the strategy_manifest
*/

import * as scoringFunctions from './scoring_functions.js';

/* Re-use the same log from the sim_engine, populated directly via function export (to sim_engine) */
let info  = () => {};
let probe = () => {};
export function setLog(logFunc) { info = logFunc; }
export function setLog2(logFunc2) { probe = logFunc2; }

export function invokePoolAgent(activeEvent, p, blocks) {
/* Entry point from the sim_engine, flow coordinator for pool behavior, returns the API contract */
   info(() => `invokePoolAgent:   ${activeEvent.simClock.toFixed(7)} ${p.id} action: ${activeEvent.action}`);
   //info(() => `idx: ${p.config.run.sweepId} ${JSON.stringify(p.config, null, 2)}`);

   const newTip = activeEvent.newIds.at(-1);  // chaintip of newIds (order guaranteed)

   /* Chaintip is already scored. No double scoring */
   if (p.scores[newTip]?.cumDiffScore) return {
      chaintip: p.chaintip, honTip: p.honTip,
      timestamp: null, scores: null, broadcastIds: null, requestIds: null
   };

   /* Analyze the branch path between newTip <--> ancestor. Compile important scoring variables */
   const [scores, scoresIds, ancestorId, requestIds] = resolveBranch(activeEvent, p, blocks, newTip);
   /* Attempt to score new blocks. First failure indicates inability to score descendants (break) */
   for (const id of scoresIds)
      if (!scoreBlock(activeEvent, p, blocks, scores, id)) break;

   /* If the newTips contained a missing link, we should score the descendant blocks now */
   scoreDanglingChaintips(activeEvent, p, blocks, scores, newTip);

   /* Finally, with all possible scores rendered, identify the highest scoring chaintip */
   const maxTip = findHighestScore(p, scores);

   /* Declare struct of the return contract API */
   let results = {
      chaintip:     p.chaintip,
      honTip:       null,
      timestamp:    null,
      scores:       null,
      broadcastIds: [],
      requestIds:   requestIds.size ? requestIds : null,
   };

   /* Switch pool behavior between honest vs selfish */
   if (p.config?.policy?.honest) {
      /* Determine if the maxTip unlocked by newIds is higher scoring than the current p.chaintip */
      const poolTipScore = p.scores[p.chaintip].cumDiffScore;
      results.chaintip = maxTip[0] > poolTipScore
         ? maxTip[1] : p.chaintip;        // Also handles maxTip = null (out-of-order block arrival)

      if (activeEvent.action === 'RECV_OWN') {  // Pool's own blocks treated preferentially in a tie
         if (maxTip[0] === poolTipScore) results.chaintip = maxTip[1];
         results.timestamp = scores[newTip].localTime;
         results.broadcastIds = [newTip];
      }
   } else {
      executeSelfishStrategy(activeEvent, p, blocks, scores, newTip, ancestorId, maxTip, results);
   }

   /* Returned scores must show the pool's selected chaintip and isHeadPath */
   propagateHeadPathToScores(activeEvent, p, blocks, scores, ancestorId, results);
   results.scores = scores;
   return results;
}

function executeSelfishStrategy(activeEvent, p, blocks, scores, newTip, commonAncestor, maxTip, results) {
/*
   The predominant selfish strategies can be generalized to two knobs: kThresh and retortPolicy.
   Combined with `state` (derived from examining the honest/selfish common ancestor), a large range
   of SM behavior can be expressed in 3 simple policy equations, avoiding complex switching logic.
*/
   info(() => `implementSelfish:  ${activeEvent.simClock.toFixed(7)} ${p.id} newTip: ${newTip}`);

   const retortPolicy  = p.config.policy.retortPolicy;  // Silent vs equal-fork vs keep-lead
   const kThresh       = p.config.policy.kThresh;       // Key inflection point after gaining a lead
   info(() => `implementSelfish:  kT: ${kThresh} rP: ${retortPolicy}`);

   let selfTip, honTip, honAdded = 0;
   if (activeEvent.action === 'RECV_OWN') {
      selfTip        = newTip;
      honTip         = p.honTip;
      commonAncestor = honTip;     // Ancestor walk *almost* always begins at the stored p.honTip.
      while (!p.scores[commonAncestor].isHeadPath) commonAncestor = blocks[commonAncestor].prevId;

      /* Edge case: Genuine overlapping blockTime by selfish -> The real ancestor will be prevId */
      if (p.scores[honTip]?.isHeadPath && blocks[selfTip].height === blocks[honTip].height)
         commonAncestor = blocks[honTip].prevId;

      results.chaintip  = newTip;                     // Might as well set some of the results now
      results.timestamp = scores[newTip].localTime;

   } else {
      /* maxTip null means there's no verified honTip extension. Keep p.chaintip, skip analysis */
      if (!maxTip[1]) {
         results.chaintip = p.chaintip;
         return;
      }
      honTip         = maxTip[1];
      selfTip        = p.chaintip;
      honAdded       = blocks[honTip].height - blocks[p.honTip].height;
      results.honTip = honTip;
   }

   /* Calculate lengths of the honest vs selfish branches */
   const ancestorHeight = blocks[commonAncestor].height;
   const honLength      = blocks[honTip].height - ancestorHeight;
   const selfLength     = blocks[selfTip].height - ancestorHeight;
   const kNew           = selfLength - honLength;
   const zeroPrimeBump  = (selfLength > 1 && kNew === 1 && activeEvent.action === 'RECV_OWN') ? 2 : 1;

   info(() => `implementSelfish:  ${activeEvent.simClock.toFixed(7)} ${p.id} k: ${kNew} sL: ${selfLength}`
      + ` hL: ${honLength} addL: ${honAdded} maxTip: ${maxTip[1]} anc: ${commonAncestor}`);

   /* Core of the generalized SM logic. For rationale and details see: docs/SELFISH_TUNING.md */
   const abandonThresh = (honLength) * (Math.min(0, kThresh) - kNew);
   const claimThresh   = (honLength) * (Math.max(0, kThresh) - kNew + zeroPrimeBump);
   const retortCount   = Math.min(retortPolicy * honAdded, honAdded + 1);

   info(() => `implementSelfish:  ${activeEvent.simClock.toFixed(7)} ${p.id} `
      + `abandon: ${abandonThresh} claim: ${claimThresh} retortCnt: ${retortCount}`);

   /* Abandon on policy trigger, or if there's no selfish branch (protects when kThresh < 0) */
   if (abandonThresh > 0 || selfLength === 0) {
      results.chaintip = maxTip[1];
      return;
   }
   /* If triggered, assemble the list of unbroadcast blocks that might be broadcast */
   let unbroadcast = [];
   if (claimThresh > 0 || retortCount > 0) {
      let id = results.chaintip;
      while (!blocks[id].broadcast) {
         unbroadcast.push(id);
         id = blocks[id].prevId;
      }
      unbroadcast.reverse();
   }
   /* Broadcast the list as appropriate */
   results.broadcastIds = (claimThresh > 0 )
      ? unbroadcast
      : unbroadcast.slice(0, retortCount);
   if (results.broadcastIds.length === 0) return;

   /* Broadcast tip could have higher score than results.honTip. Check and update */
   const bcTip       = results.broadcastIds.at(-1);
   const bcTipScore  = scores[bcTip]?.cumDiffScore  ?? p.scores[bcTip].cumDiffScore;
   const honTipScore = scores[honTip]?.cumDiffScore ?? p.scores[honTip].cumDiffScore;
   if (bcTipScore > honTipScore) results.honTip = bcTip;
}

function scoreBlock(activeEvent, p, blocks, scores, id) {
/*
   Must be careful to separate our code's global view, `blocks`, from the pool's view: `scores`.
   Collect list of blocks that need to be requested (if any), then score the block, if able.
*/
   info(() => `scoreBlock         ${activeEvent.simClock.toFixed(7)} ${p.id} blockId: ${id}`);

   const prevId = blocks[id].prevId;
   const prevCumDiffScore = p.scores[prevId]?.cumDiffScore ?? scores[prevId]?.cumDiffScore;
   if (!prevCumDiffScore) return false;
   scores[id].diffScore = blocks[id].difficulty;      // Start with base difficulty of the block

   /* Iterate over the scoring functions listed for the pool's strategy in the manifest, */
   let adjustment = 0;
   const scoringList = p.config?.scoring || {};            // No config = base case NC
   for (const funcName in scoringList) {
      const scoringFunction = scoring[funcName];
      if (typeof scoringFunction !== 'function')
         throw new Error('Non-existent scoring function: ' + funcName);
      const parameters = scoringList[funcName];
      adjustment += scoringFunction(blocks, p, id, parameters);
   }
   scores[id].diffScore    += BigInt(adjustment);                   // Final scores adjustment
   scores[id].cumDiffScore  = prevCumDiffScore + scores[id].diffScore;
   return true;
}

function resolveBranch(activeEvent, p, blocks, newTip) {
/*
   Code logic needs the full branch from newIds back to ancestorId. Walk backwards via prevId
   until the first pool-scored block is regarded as isHeadPath. That's the common ancestor.
*/
   info(() => `resolveBranch:     ${activeEvent.simClock.toFixed(7)} ${p.id} newTip: ${newTip}`);

   let id            = newTip;
   let scores        = Object.create(null);
   let scoresIds     = [];
   let requestIds    = new Set();
   const startHeight = blocks[activeEvent.newIds[0]].height;

   while (true) {
      const score = (p.scores[id] ?? (activeEvent.newIds.includes(id) ? {
         /* Record ingress-time for each received block (only if it's not already recorded) */
         simClock:     activeEvent.simClock,
         localTime:    Math.floor(activeEvent.simClock + p.ntpDrift),
         diffScore:    null,
         cumDiffScore: null,
         isHeadPath:   false,
         chaintip:     null
      } : null));

      if (score?.isHeadPath) break;    // Found the ancestor
      if (score) {       // Only block heights >= activeEvent window are relevant for scoring
         if (blocks[id].height >= startHeight) {
            scores[id] = score;
            scoresIds.push(id);        // Using a separate array to guarantee order
         }
      } else {
         requestIds.add(id);           // Pool doesnt have the block, must request it
      }
      id = blocks[id].prevId;          // Travel backwards via prevId
   }
   scoresIds.reverse();
   return [scores, scoresIds, id, requestIds];
}

function scoreDanglingChaintips(activeEvent, p, blocks, scores, newTip) {
/*
   Sometimes an out-of-order block is the missing link in a chain of descendant blocks.
   Now that the link has been received, score the descendants who were waiting for completion.
   If scored successfully, these must be added to `scores` and returned to the sim_engine.
*/
   info(() => `scoreDanglingTips: ${activeEvent.simClock.toFixed(7)} ${p.id}`);

   if (!scores[newTip]?.cumDiffScore) return;         // Tip must have a score to propagate
   const startHeight = blocks[newTip].height;

   const unscored = Array.from(p.unscored.entries())  // Clone to prevent mutating global state
      .filter(([, height]) => height > startHeight)
      .sort(([, a], [, b]) => a - b);

   /* Loop over unscored by height, low-to-high, to check if descendant from newTip */
   const prevIds = new Map([[startHeight, [newTip]]]);   // Rolling map of height,[ids] fast lookup
   for (const [id, height] of unscored) {
      if (!prevIds.has(height - 1)) break;        // Remaining unscored have no path back to newTip

      const prevId = blocks[id].prevId;
      if (prevIds.get(height - 1).includes(prevId)) {
         scores[id] = p.scores[id];               // Block can be scored. Add to scores
         if (scoreBlock(activeEvent, p, blocks, scores, id)) {
            if (!prevIds.has(height)) prevIds.set(height, [id]);
            else prevIds.get(height).push(id);
         }
      }
   }
}

function findHighestScore(p, scores) {
/*
   Identifies the highest score relevant to the completed branch of the newIds, not
   the pool itself. Used later for p.chaintip determination, and selfish k calculations
*/
   let maxTip = [ 0n , null ];  // Use BigInt explicitly (no coercion)
   for (const id in scores) maxTip = scores[id].cumDiffScore > maxTip[0]
      ? [ scores[id].cumDiffScore , id ]
      : maxTip;

   return maxTip;
}

function propagateHeadPathToScores(activeEvent, p, blocks, scores, ancestorId, results) {
/*
   Having walked backwards/forwards from the newIds, scored all blocks known to the pool, and
   determined the chaintip based on strategy; this function A) sets the chaintip for all new
   scores; and B) toggles isHeadPath for both orphans/live, adding to `scores` obj if necessary.
   Tracking isHeadpath in the global state, is a code-efficient means of finding the ancestor.
*/
   info(() => `propagateHeadPath: ${activeEvent.simClock.toFixed(7)} ${p.id} ancestor: ${ancestorId}`);

   /* p.scores reflects which chaintip the pool selected upon first visibility of the block */
   for (const id in scores) if (!scores[id].chaintip) scores[id].chaintip = results.chaintip;

   /* Walkback until: A) normal extension of chaintip, or B) id = ancestor (indicating reorg) */
   let id = results.chaintip;
   while (id !== p.chaintip && id !== ancestorId) {
      if (!scores[id]) scores[id] = p.scores[id];
      scores[id].isHeadPath = true;   // Maintain which blocks are in the pool's heaviest path
      id = blocks[id].prevId;
   }

   /* If reorg, the orphaned scores must be changed, walking back from p.chaintip to ancestor */
   if (id === ancestorId) {
      id = p.chaintip;
      while (id !== ancestorId) {
         if (!scores[id]) scores[id] = p.scores[id];
         scores[id].isHeadPath = false;   // Orphans are no longer in the pool's heaviest path
         id = blocks[id].prevId;
      }
   }
}
