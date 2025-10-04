/*
   Heart of the simulation. Runs events continuously until SIM_DEPTH is reached
*/

import TinyQueue from 'tinyqueue';

/* These are "global" to the engine. Highly integrated shared state, procedurally mutated */
let sim, state, LOG, simNoise, strategies,
    pools, blocks, startTip, diffWindows, info, probe, stats, eventQueue;

function timeNow() {
   return new Date().toLocaleTimeString();
}
function msNow() {
   return new Date().toISOString().slice(11, 23);
}

function simulateBlockTime(p, simClock) {
/* Simulated a new blockTime, whenever a pool changes chaintip.  */

   const nxtDifficulty = blocks[p.chaintip].nxtDifficulty;
   const lambda        = p.hashrate / Number(nxtDifficulty);  // Downgrade from BigInt
   const timeToFind    = simNoise.blockTime(lambda);

   /* Hashers can only start mining the new template after network latency */
   eventQueue.push({
      simClock: simClock + simNoise.owdP2H() + timeToFind,
      poolId:   p.id,
      action:  "HASHER_FIND",
      chaintip: p.chaintip,  // This is the old chaintip blockId that will be extended
      newIds:   null,        // No newId until the event is verified as "sim"-real
   });
   info(() => `simulateBlockTime: ${simClock.toFixed(7)} ${p.id} tip: ${p.chaintip} ` +
       `timeToFind: ${timeToFind.toFixed(0)}`);
}

function hasherFindsBlock(p, activeEvent) {
/*
   We model the exact network/latency relationships that can cause a fork.
   When a pool switches chaintip, there's a window based on pool-to-hasher 1-way
   ping, where the hasher solves the old block before receiving the new template.
*/
   /* The event chaintip must be relevant to the state of the pool (not stale) */
   if (activeEvent.chaintip !== p.chaintip) {                          // Might be stale
      if (activeEvent.chaintip !== blocks[p.chaintip].prevId) return;  // Definitely stale

      /* If hasher would've found the (hypothetical) block after template arrival, return */
      const hasherRecvTime = p.scores[p.chaintip].simClock + simNoise.owdP2H();
      if (activeEvent.simClock > hasherRecvTime) return;
   }

   /* The block is valid from the hasher's perspective. Send to pool */
   let newEvent       = {...activeEvent};
   newEvent.simClock += simNoise.owdP2H();  // Add network latency to future event
   newEvent.action    = "RECV_OWN";
   eventQueue.push(newEvent);

   info(() => `hasherFindsBlock:  ${activeEvent.simClock.toFixed(7)} ${p.id} tip: ${p.chaintip}`);
}

function generateBlock(p, activeEvent) {
   /* The pool could've received a competing block before the hasher's solution arrived */
   if (activeEvent.chaintip !== p.chaintip)                     // Might be stale
      if (activeEvent.chaintip !== blocks[p.chaintip].prevId)   // Definitely stale
         return false;

   /* RECV_OWN is valid. Create a new block and score for the pool */
   const b          =  blocks[activeEvent.chaintip];            // block being extended
   const newBlockId = `${b.height + 1}_${activeEvent.poolId}`;
   const newBlock = {
      simClock:       activeEvent.simClock,
      height:         b.height + 1,
      poolId:         activeEvent.poolId,
      blockId:        newBlockId, 
      prevId:         b.blockId,
      timestamp:      null,                  // Defer, as strategies might manipulate timestamp
      difficulty:     b.nxtDifficulty,
      cumDifficulty:  b.nxtDifficulty + b.cumDifficulty,
      nxtDifficulty:  null,                  // Needs a timestamp. Defer till after strategy
      broadcast:      null,                  // Need pool strategy before deciding to broadcast
   }
   blocks[newBlockId]   = newBlock;
   activeEvent.newIds   = [newBlockId];      // API requires an array

   info(() => `generateBlock:     ${activeEvent.simClock.toFixed(7)} ${p.id} newId: ${newBlockId}`);
   return true;
}

function broadcastBlock(newIds, activeEvent) {
/*
   Simulate network delays, then create a new RECV event for each pool. Only single blocks are
   broadcast. Strategy functions determine if they need to catch up on history behind that block. 
*/
   /* Guarantee ascending order by height of newIds for new events */
   newIds = newIds.toSorted((a, b) => blocks[a].height - blocks[b].height);

   for (const p of Object.values(pools)) {
      if (p.id === activeEvent.poolId) continue;             // Skip pool who found the block
      eventQueue.push({
         simClock:  activeEvent.simClock + simNoise.owdP2P(),  // Assume fluffy, no BW penalty
         poolId:    p.id,
         action:   "RECV_OTHER",
         chaintip:  null, 
         newIds:    newIds,
      });
   }
   for (const id of newIds) blocks[id].broadcast = true;   // Set the block as broadcast
   info(() => `broadcastBlock:    ${activeEvent.simClock.toFixed(7)} ${activeEvent.poolId} blocks: ${newIds}`);
}

function reconstructDiffWindow(blockId) {
   info(() => `reconstructDiffWindow: diffWindow missing for ${blockId}. Reconstructing it ...`);
   const diffWindow  = [];
   let loopId = blockId;
   for (let i = 0; i < (sim.diffWindow + sim.diffLag) && loopId; i++) {
      const b = blocks[loopId];
      diffWindow.push({ timestamp: b.timestamp, cumDifficulty: b.cumDifficulty, });
      loopId = b.prevId;
   }
   diffWindow.reverse();
   diffWindows[blockId] = diffWindow;
}

function calculateNextDifficulty(blockId) {
/*
   Full block difficulty adjustment. diffWindows has the timestamps and cumDifficulty of each
   contender chaintip. We extract and sort those arrays to look like difficulty.cpp.
*/
   /* Difficulty adjustment constants */
   const DIFFICULTY_TARGET_V2 = sim.diffTarget;
   const DIFFICULTY_WINDOW    = sim.diffWindow;
   const DIFFICULTY_CUT       = sim.diffCut;
   const DIFFICULTY_LAG       = sim.diffLag;

   if (!diffWindows[blockId]) reconstructDiffWindow(blockId);           // Safety for edge cases

   const diffWindow = [...diffWindows[blockId]]
      .slice(0, -DIFFICULTY_LAG).slice(-DIFFICULTY_WINDOW)  // Discard recent, ensure 720 length
      .sort((a, b) => a.timestamp - b.timestamp);
   const timestamps              = diffWindow.map(h => h.timestamp);
   const cumulative_difficulties = diffWindow.map(h => h.cumDifficulty);
   const length = timestamps.length;
   if (length <= 1) return 1n;                              // Genesis block. Set to `1n` (BigInt)

   /* Determine the cut range for outlier removal */
   let cut_begin, cut_end;
   if (length <= DIFFICULTY_WINDOW - 2 * DIFFICULTY_CUT) {
      cut_begin = 0;
      cut_end = length;
   } else {
      cut_begin = Math.floor(
                  (length - (DIFFICULTY_WINDOW - 2 * DIFFICULTY_CUT) + 1) / 2);
      cut_end = cut_begin + (DIFFICULTY_WINDOW - 2 * DIFFICULTY_CUT);
   }

   /* Calculate the time span from the trimmed, sorted timestamps */
   let time_span = timestamps[cut_end - 1] - timestamps[cut_begin];
   if (time_span === 0) time_span = 1;   // Prevent division by zero
   time_span = BigInt(time_span);        // Convert to BigInt for accuracy in calcs later

   /* Calculate the total work, and the new difficulty */
   const total_work     = cumulative_difficulties[cut_end - 1] - cumulative_difficulties[cut_begin];
   const target_seconds = BigInt(DIFFICULTY_TARGET_V2);
   const new_difficulty = (total_work * target_seconds + time_span - 1n) / time_span;

   info(() => `calcNxtDifficulty: ${blocks[blockId].simClock.toFixed(7)} block: ${blockId} ` +
       `nextDifficulty: ${new_difficulty}`);
   return new_difficulty <= 0n ? 1n : new_difficulty;
}

function integrateStrategyResults(p, activeEvent, results) {
/*
   Had to defer critical state changes / events until receiving results from the plugin strategy.
   Integrate return contract: { chaintip, timestamp, scores, broadcastId }, into the current state. 
   * Correct API handling by strategies is crucial. No other way to achieve strategy modularity.*
*/
   info(() => `integrateStrategy: ${activeEvent.simClock.toFixed(7)} ${p.id} resultip: ${results.chaintip}`);

   /* Remove received blocks (newIds set) from the pool's request list */
   for (const id of activeEvent.newIds || []) p.requestIds.delete(id);

   if (results.timestamp) {
      const oldTip = activeEvent.chaintip;
      const newTip = results.chaintip; 
      const bOld   = blocks[oldTip];
      const bNew   = blocks[newTip];
      bNew.timestamp = results.timestamp;

      /* Difficulty window wasnt updated earlier because sorting with a null timestamp, fails */
      if (!diffWindows[oldTip]) reconstructDiffWindow(oldTip);  // Edge cases can delete needed window
      diffWindows[newTip] = diffWindows[oldTip].slice(1).concat({
         timestamp:     results.timestamp,
         cumDifficulty: bNew.cumDifficulty
      });
      bNew.nxtDifficulty = calculateNextDifficulty(newTip);
   }

   /* Add the new scores to the pool's database, while tracking unscored blocks for sim efficiency */
   if (results.scores) {

      /* Sort by height here, to save a sort later during metrics and data prep */
      results.scores = Object.fromEntries(Object.entries(results.scores)
         .sort(([idA],[idB]) => blocks[idA].height - blocks[idB].height));

      Object.assign(p.scores, results.scores);
      for (const id in results.scores) {
         if (results.scores[id].cumDiffScore === null) p.unscored.set(id, blocks[id].height);
         else p.unscored.delete(id);
      }
   }

   /* Tracking honTip explicitly, helps code-efficiency inside the selfish strategies module */
   if (results.honTip) p.honTip = results.honTip;
   if (p.chaintip !== results.chaintip) {            // Chaintip is the head being mined by the pool
      p.chaintip = results.chaintip;
      simulateBlockTime(p, activeEvent.simClock);
   }

   /* Maintains realism for out-of-order blocks, and partition healing */
   if (results.requestIds) {
      let requestIds = new Set();
      for (const id of results.requestIds) {  // Prevent duplicate future events/requests
         if (!p.requestIds.has(id)) {
            p.requestIds.add(id);
            requestIds.add(id);
         }
      }
      if (requestIds.size > 0) {  // Use heuristic - No fluffy for missing blocks. It's a negligible
         eventQueue.push({        // factor for fast a network, but critical for a degraded network.
            simClock:  activeEvent.simClock + 2*simNoise.owdP2P() + simNoise.transTime()*requestIds.size,
            poolId:    p.id,
            action:   "RECV_OTHER",
            chaintip:  null,                               // Guarantee height-order of newIds
            newIds:    [...requestIds].toSorted((a, b) => blocks[a].height - blocks[b].height),
         });
      }
   }

   if (results.broadcastIds?.length > 0) broadcastBlock(results.broadcastIds, activeEvent);
}

function resourceManagement() {
   /* Prune unused diffWindows to keep memory usage down */
   const keepWindows = new Set();
   for (const p of Object.values(pools)) {
      keepWindows.add(p.chaintip);
      const prev = blocks[p.chaintip]?.prevId;
      if (prev) keepWindows.add(prev);
   }
   for (const k in diffWindows) if (!keepWindows.has(k)) delete diffWindows[k];

   /* Prevent popped events from lingering and consuming memory */
   if (eventQueue.data.length > eventQueue.length * 3) eventQueue.data.length = eventQueue.length;
}

function processActiveEvent(activeEvent) {
/* Logical encapsulation of the process flow for each unique pop'd event */
   const p = pools[activeEvent.poolId];

   /* The moment a hasher finds a block */
   if (activeEvent.action === 'HASHER_FIND') {
      hasherFindsBlock(p, activeEvent)
      return;
   }
   /* The moment a pool receives block solution from one of its hashers */
   if (activeEvent.action === 'RECV_OWN' && !generateBlock(p, activeEvent)) return;

   /* Strategy function handles both RECV_OWN/RECV_OTHER. The line below is a function call */
   const strategyResults = strategies[p.strategy](activeEvent, p, blocks);

   /* Contract parameters returned from strategy function must be integrated into sim state */
   integrateStrategyResults(p, activeEvent, strategyResults);
}

export function runSimulationEngine(engineContext) {
/* 
   Pool state changes depend on other pools' actions + network delays. We cant simply generate
   and process events sequentially. We simulate latency, and add future events to the queue.
*/ 
   ({ sim, state, LOG, simNoise, strategies } = engineContext);
   ({ pools, blocks, startTip, diffWindows }  = state);
   ({ info, probe, stats } = LOG);

   /* Binary heap time ordering (fast search). 5 checks for ultimate tie breaking resolution */
   eventQueue = new TinyQueue([], (a, b) => {
      if (a.simClock !== b.simClock) return a.simClock - b.simClock;
      if (a.poolId   !== b.poolId)   return a.poolId.localeCompare(b.poolId);
      if (a.action   !== b.action)   return b.action.localeCompare(a.action); // RECV_OWN first
      if (a.chaintip !== b.chaintip) return a.chaintip.localeCompare(b.chaintip);
      const aNewId = Array.isArray(a.newIds) ? a.newIds.at(-1) : '0';
      const bNewId = Array.isArray(b.newIds) ? b.newIds.at(-1) : '0';
      if (aNewId !== bNewId) return aNewId.localeCompare(bNewId);
      return 0;
   });

   /* We must seed the eventQueue. Calc difficulty for the startTip, and run the first blockTimes */ 
   blocks[startTip].nxtDifficulty = calculateNextDifficulty(startTip);
   for (const p of Object.values(pools))
      simulateBlockTime(p, blocks[startTip].simClock);

   /* Event queue engine. Continuous event creation and execution until depth is reached */
   const simDepth = blocks[startTip].simClock + (sim.depth * 3600);
   let activeEvent;
   while (activeEvent = eventQueue.pop()) {   // TinyQueue pop() removes obj with lowest comparator
      if (activeEvent.simClock > simDepth) break;
      info(() => `SimCoreEngine:     ${activeEvent.simClock.toFixed(7)} ` +
                                    `${activeEvent.poolId} action: ${activeEvent.action}`);

      processActiveEvent(activeEvent);
      resourceManagement();           // Restrain heap growth by trimming diffWindows and eventQueue
   }
}
