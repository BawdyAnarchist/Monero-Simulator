import * as scoringFunctions from './scoring_functions.js';

/* Debug helper */
const debug = (() => {
  if (process.env.DEBUG === 'true') return (...m) => console.log('[DBG]', ...m);
  return () => {};
})();

export function invokeStrategyH(activeEvent, p, blocks) {
   debug(`invokeStrategy BEGIN: clock: ${activeEvent.simClock}, pId: ${p.id}`);

   const newTip   = activeEvent.newTip;         // blockId of the new proposed chaintip
   /* Block created by self. return { chaintip, timestamp, scores , broadcastId } */ 
   if (p.id === blocks[newTip].pool) return {
      chaintip:    newTip,
      timestamp:   p.scores[newTip].localTime,
      scores:      null,
      broadcastId: newTip
   };

   /* Pool can receive blocks out of order, due to simulated latency. Return immediately if already scored */ 
   if (p.scores[newTip]) return { chaintip: null, timestamp: null, scores: null, broadcastId: null };

   /* Pool needs list of unscored blocks and the ancestorId. Walk backwards from the newTip via
      prevId until the first pool-scored block regarded as the heaviest. That's the ancestor */
   const scores   = Object.create(null);
   let ancestorId = newTip;
   let newBlocks  = [];
   while (true) {
      const score = p.scores[ancestorId] ?? { isHeaviest: null };
      if (score.isHeaviest) break; 
      if (score.isHeaviest === null) newBlocks.push(ancestorId);  // Unscored. Add to the list
      ancestorId = blocks[ancestorId].prevId;                     // Travel backwards via prevId
   }
   newBlocks.reverse();                                           // Sort list chronologically  

   /* Calculate scores for all new blocks. Rolling variable to store cumulative, saves a lookup */
   const prevId     = blocks[newBlocks[0]].prevId;
   let prevCumScore = p.scores[prevId].cumDiffScore;
   for (const id of newBlocks) { 
      const b = blocks[id];
      scores[id] = {
         localTime:     Math.floor(b.simClock + p.ntpDrift),
         diffScore:     b.difficulty,
         cumDiffScore:  b.difficulty + prevCumScore,
      } 
      /* Iterate over the scoring functions listed for the pool's strategy in the manifest, */ 
      let adjustment = 0;
      const scoringList = p.config?.scoringFunctions || [];
      for (const fnName of scoringList) {
         const fn = scoringFunctions[fnName];
         if (typeof fn !== 'function') throw new Error('Non-existent scoring function: ' + fnName);
         adjustment += fn(blocks, p, id);
      }
      scores[id].diffScore    += BigInt(adjustment);         // Final scores adjustment 
      scores[id].cumDiffScore += BigInt(adjustment);
      prevCumScore = scores[id].cumDiffScore;
   }

   /* Evaluate and mark heaviest chaintip (we couldnt assign `isHeaviest` until after calculating scores) */
   let chaintip;
   if (scores[newTip].cumDiffScore > p.scores[p.chaintip].cumDiffScore) {
      chaintip = newTip;
      scores[newTip].isHeaviest = true;
   } else {
      chaintip = p.chaintip;
   }
   const results = {
      chaintip:    chaintip,
      timestamp:   null,
      scores:      scores,
      broadcastId: null
   };

   debug(`invokeStrategyH END: timestamp: ${results.timestamp},
          chaintip: ${results.chaintip}, broadcastId: ${results.broadcastId}`);
   return results;
}
