/*
   Single repository for all scoring adjustment calculations. Add custom scoring functions to this file.
   They should return a signed Number (positive for bonus score, negative for penalties). 
*/

export function calcDepthPenalty_T() {
//// NOTES: In all cases of depth penalty, for each block in the new array, we need to find the block of closest difficulty to compare for times and/or depth delay.
/* Needs to be finished, but the general idea is here */
//   const monoDiff       = 
//   const depthPenalty   = DP_L*(1 - Math.exp(DP_K * monoDiff));
//   block.blockScore.diffScore   = block.difficulty * (1 - depthPenalty);
//   block.cumDiffScore  += block.;
return;
}

export function calcDepthPenalty_B() {
return;
}

export function calcUncleBonus_T() {
return;
}

export function calcUncleBonus_B() {
return;
}

export function calcSkewPenalty_T() {
return;
}
