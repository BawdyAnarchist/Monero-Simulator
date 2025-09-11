import * as scoringFunctions from './scoring_functions.js';

/* Debug helper */
const debug = (() => {
  if (process.env.DEBUG === 'true') return (...m) => console.log('[DBG]', ...m);
  return () => {};
})();

export function invokeStrategyH(activeEvent, p, blocks) {
   debug(`invokeStrategy BEGIN: clock: ${activeEvent.simClock}, pId: ${p.id}`);
   const newTip = activeEvent.newIds.at(-1);  // chaintip of newIds (order guaranteed)

   /* Chaintip is already scored. No double scoring */
   if (p.scores[newTip]?.cumDiffScore) return {
         chaintip: p.chaintip, timestamp: null, scores: null, broadcastIds: null, requestIds: null};

   /* Analyze the branch path between newTip <--> ancestor. Compile important scoring variables */
   const [scores, scoresIds, ancestorId, requestIds] = resolveBranch(activeEvent, p, blocks, newTip);

   /* Attempt to scoring new blocks. First failure indicates inability to score descendants (break) */
   for (const id of scoresIds)
      if (!scoreBlock(activeEvent, p, blocks, scores, id)) break;

   /* If the newTips contained a missing link, we should score the descendant blocks now */
   scoreDanglingChaintips(activeEvent, p, blocks, scores, newTip);

   /* Determine heaviest chaintip, and format the final scores/results to return to the sim_core */
   const results = compileScoredResults(activeEvent, p, blocks, scores, ancestorId, requestIds);

   /* This block was mined by the pool itself. Add honest an timestamp and set for broadcast */
   if (activeEvent.action === 'RECV_OWN' && newTip === results.chaintip) {
      results.timestamp = scores[newTip].localTime;
      results.broadcastIds = [newTip];
   }

   debug(`invokeStrategyH END: timestamp: ${results.timestamp},
          chaintip: ${results.chaintip}, broadcastIds: ${results.broadcastIds}`);
   return results;
}

function resolveBranch(activeEvent, p, blocks, newTip) {
/*
   Code logic needs the full branch from newIds back to ancestorId. Walk backwards via prevId
   until the first pool-scored block is regarded as the heaviest. That's the common ancestor.
*/
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
   If scored successfully, these must be added to `scores` and returned to the sim_core.
*/
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

function scoreBlock(activeEvent, p, blocks, scores, id) {
/*
   Must be careful to separate our code's global view, `blocks`, from the pool's view: `scores`.
   Collect list of blocks that need to be requested (if any), then score the block, if able.
*/
   const prevId = blocks[id].prevId;
   const prevCumDiffScore = p.scores[prevId]?.cumDiffScore ?? scores[prevId]?.cumDiffScore;
   if (!prevCumDiffScore) return false;
   scores[id].diffScore = blocks[id].difficulty;      // Start with base difficulty of the block

   /* Iterate over the scoring functions listed for the pool's strategy in the manifest, */
   let adjustment = 0;
   const scoringList = p.config?.scoringFunctions || [];            // No config = base case NC
   for (const fnName of scoringList) {
      const fn = scoringFunctions[fnName];
      if (typeof fn !== 'function') throw new Error('Non-existent scoring function: ' + fnName);
      adjustment += fn(blocks, p, id);
   }
   scores[id].diffScore    += BigInt(adjustment);                   // Final scores adjustment
   scores[id].cumDiffScore  = prevCumDiffScore + scores[id].diffScore;
   return true;
}

function compileScoredResults(activeEvent, p, blocks, scores, ancestorId, requestIds) {
/*
   Having walked backwards/forwards from the newIds, and scored all blocks known to the pool; the
   highest scoring branch is selected. Both heaviest and orphan branches need to update isHeadPath.
   Tracking which scores are in the heaviest chain (vs orphans), helps quickly find common ancestor.
*/
   /* Determine the correct pool chaintip */
   const poolTipScore = p.scores[p.chaintip].cumDiffScore;
   let maxTip = [ 0n , null ], chaintip;                 // Use BigInt explicitly (no coercion)
   for (const id in scores) maxTip = scores[id].cumDiffScore > maxTip[0]
      ? [ scores[id].cumDiffScore , id ]
      : maxTip;
   chaintip = maxTip[0] > poolTipScore ? maxTip[1] : p.chaintip;

   /* A pool always regards blocks from its own hashers with preference, even if received later */
   if (activeEvent.action === 'RECV_OWN' && maxTip[0] === poolTipScore) chaintip = maxTip[1];

   /* Every new score must receive a chaintip (we track the pool's chaintip at each new event) */
   for (const id in scores) if (!scores[id].chaintip) scores[id].chaintip = chaintip;

   /* Walkback until: A) normal extension of chaintip, or B) id = ancestor (indicating reorg) */
   let id = chaintip;
   while (id !== ancestorId && id !== p.chaintip) {
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

   return {
      chaintip:     chaintip,
      timestamp:    null,
      scores:       Object.keys(scores).length ? scores : null,
      broadcastIds: null,
      requestIds:   requestIds.size ? requestIds : null,
   };
}

