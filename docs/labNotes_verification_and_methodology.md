
---

This document is an informal free-form personal log regarding the state of correctness verification and methodology notes for the project as a whole.

---

Oct 8, 2025

In the development of this project, a number of checks and methodology decisions have been made along the way, that arent fully documented/proven. Recreating and documenting these would take some effort, and perhaps that will be accomplished in the future, but for now this serves as a rough outline of the kinds of checks/verifications that have been done. Many of them can be reproduced easily enough.

## Block Times / Frequency

Multiple runs of 10-20 rounds, whether dozens of hours or thousands of hours, consistently show the number of blocks averaging very close to the expectation for the duration (basically multiplying the number of hours by 30, given Monero's setup parameters). I have not however, gone to the rigor of plotting a histogram of block times and statistically verifying against a pure probability distribution.

## Hashrate Block Shares

Multiple runs over long timeframes also demonstrate distribution of blocks among the pools, as being very closely aligned with their assigned percentage hashpower in pools.json. Again, this is easy enough for anyone to verify and inspect, using data/logs native to the repo.

## Difficulty Algorithm

The exact history was pulled from a standard Monero full node. The sim-calculated difficulties for blocks after the historical bootstrap matched the values seen for the real blocks produced by the network, for at least up to the next ... I believe it was at least 30 new blocks that were checked, but it might have been more. In general, you can see that, based on the NETWORK_HASHRATE input parameter, difficulty values remain consistent around the starting point over the course of very long simulations of solely honest pools.

Admittedly this is not as rigorous as a unit test, feeding a long running series of exact empirical data over many historical profiles and checking for perfect adherence. Nevertheless, for the limited data analyzed, there was an exact match. 

Finally, there is likely a slight divergence in the way that trimming is accomplished. This would be a factor and a problem for modeling timestamp noise. For the preliminary analysis, NTP drift was modeled low, at a 1-sec stdev normal distribution, making the divergence negligible/irrelevant for those results. This will be fixed in future versions.

## Ping Values Inspection

Some deeper thought was put into the stochastic latency model. While ping and one-way-delay (OWD) generally follow a log normal distribution, there are tail spikes due to wifi, routing, switching, and other network infrastructure artifacts. The stats() log was inspected for reasonable/sane values, and over tens of thousands of data points showed averages at their expected values. However, further corroboration could be accomplished with a histogram to visualize the exact probability curve, and of course check that against statistical expectations. 

It was estimated that 70ms is a reasonable ping average for pools which often operate redundant infrastructure in data centers. For hashers which often sit behind firewalls, consumer internet, and/or less well connected or geographically distant global locations - 140ms was guessed to be the average. This is hard-coded as 2x higher than the `PING` input parameter (pool-to-pool ping).

In a more speculative but necessary endeavor - the aforementioned tail spike probability should be adjusted upwards commensurate with input PING, to have a hope of a sane representation of global internet degradation. As internet degrades, so does the probability and severity of tail spikes. In the absence of sufficient time to pour over research, some very rough ideas of what constitutes various degrees of degradation were examined, and a bit of commented mathemagic in the stochastic model was inserted. This was hand crafted, again, attempting to value match something resembling plausibly sane probabilities and tail spike delays as PING increases beyond 1000ms. This is undoubtedly inaccurate as PING rises to multiple seconds; HOWEVER, it is almost certainly more accurate than not modeling it at all. 

Obviously, deeper research would be needed refine the tail spike model specifically, and the stochastic model of global internet latency in general. At a minimum, I'm mostly confident that the baseline model for ping below 1000ms is reasonable.

## Stochastic Sampling

Some basic optimizations were attempted for the stochastic implementation. Uniquely seeding each stochastic sampler reduces variance when comparing between permutations. Further work still needs to be accomplished here, by creating pool-specific seeded generators for each sampled distribution. Particularly for block times. This would further reduce variance, and confer slightly more confidence when analyzing permutations for statistically significant differences.

## Orphan Rate

The orphan rate in a fully honest network is purely a function of the PING input parameter. There are no heuristics applied to achieve an orphan probability, save that of the stochastic latency model for all pool/hasher/pool communication delays. The byproduct of this delay is what produces honest forks. At 70ms ping, the sim produces about **0.25%** orphan rate, which is right in line with empirical observations of the real world network. This too, is easy enough to verify by running the sim with with DATA_MODE=full, and inspecting the summary metrics.

A minor but perhaps revealing detail ... *The development of the latency model and selection of 70ms baseline ping was NOT targeted at producing any particular orphan rate result.* Neither was there any backwards adjustment (juicing the inputs so to speak) in order to achieve an orphan rate congruent with the real world Monero network. It wasnt even checked until the tail end of development; as the broader and more general analysis suite (the metrics module) was considered a higher priority (a requirement for sweep/permutations analysis).

## Selfish Strategies Equation

This is perhaps the most complex implementation, and was custom created for the simulation as a means of avoiding sprawling switch decision logic, which can be not only tedious to verify, but consume precious runtime resources. Nevertheless, verifying the (basically) 9 relevant selfish permutations of `kThresh` and `retortPolicy` over all the important (and sometimes edge case) conditions that can occur onchain, is no simple matter.

As an anecdotal testament, I have scrutinized hundreds of results_scores.csv output scenarios over all 9 permutations, and have not found any deviations.

As a more detailed accounting, I constructed a spreadsheet of the various combinations of selfish block arrivals vs honest block arrivals for each of the selfish permutations, double and triple checking the expected behavior, including their specific code-variable values that can be check against the logs.

Furthermore, I isolated the core equation and setup logic which leads to it, and then used the spreadsheet to construct a set of mock objects, imported into a test script, with command line comma separated outputs that can be dumped into the constructed spreadsheet for direct comparison. This process was rather manual, perhaps not the most efficient, but at least visually easier to follow than other methods might have been. Things like conditional highlighting for good/bad values.

While there is no unit test for the executeSelfishStrategy() function in unified_pool_agent.js, the equation does perform as designed. Even so, the handling of the outputs of the equation still require care and attention in the code, for pool behavior switching. 

In summary, lacking formal proofs of correctness, unit tests, and broader integration tests, I can only again assert that deep inspection of the results_scores output over hundreds of the expected combinations of circumstances, I have been unable to find any deviation from the expected pool behavior.

## Unified pool agent

Much of what was written for the selfish strategies equations, doubles here. Creating clear unified logic of an agentic pool is not a trivial matter; particularly when every extra lookup, loop, and operation will be at best an additive load on RAM/CPU usage as SIM_DEPTH increases. 

In a more purist architectural vision, one would prefer to implement fully generalized agentic behavior that uses only pools and pools.scores to assess the relative view of the chain state and construct the contract API to return the mutations necessary to update the pool. In diametric contradistinction, is the very real temptation for variables/object sprawl to assist with decision making for all of the edge cases and nuance that arises under various state combinations. 

I opted to maintain architectural purity and generalization to the greatest extent possible, sacrificing that purity only to address seemingly inescapable bottlenecks -> typically involving "reverse lookups" where you need to find a blockId or score that satisfies some property. Specifically: keeping a list of blocks the pool has been unable to score (out-of-order arrivals); a list of blocks the pool has already requested; and tracking the selfish pool's belief of the honest chaintip.

Perhaps the most glaring tradeoff was to forego the deep cloning of the pools and blocks objects, passing them directly to the agent. This creates a very real danger of accidentally mutating the sim-engine module global state. However, clones are expensive, and we're running thousands of sim-hours over hundreds of permutations. Luckily, this is a trivial .."fix"..; but benchmarking the cost of doing so would be paramount before any change. 

In summary, again I can only assert that deep inspection of hundreds of edge case scenarios (as well as significant troubleshooting and error logging during development), reveals no misbehavior or runtime exceptions that I can find. Out of order blocks, reorgs, forks, and completion of unscored branches all appear to be functioning as expected.

# Metrics calculation

Arguably this is growing large enough that it should be modularized. Particularly as the preliminary analysis required some dedicated adhoc probing to get all the data I needed. Using low SIM_DEPTH of 1-100 hours, I have corroborated the metrics outputs with visually-inspectable (namely spreadsheet friendly) checks. 

The only thing that still bugs me is the gamma calculation. Determining exactly WHICH block a selfish miner has asserted as a contention for the chain head in an attempt to distract hashpower, has some nuance. I think it's at least *mostly* correct, but I'm not convinced that it's 100% fully correct for the full range of selfish strategies. For example, the trailing stubborn strategies do publish the block which gets them back to `0'` (after falling behind), but this block isnt a legitimate contention for the chain head ... yet it still counts into the calculation of total contentious blocks. This probably just needs some extra check/switching logic.

---

# Conclusions

The architecture and modular organization of the project are quite strong, and sufficient analysis tooling is incorporated (`stats(), probe(), info()`); such that, it should not be a monumental task to close gap on these documented shortcomings of full verification of the simulation outputs. The insertion points and analysis should for the most part be relatively straightforward even for a newcomer to the code base.

Nevertheless, there are quite a many items to address, and each needs a level of mathematical rigor and documentation. Given the time factor, and a code base that isnt terribly large or complex; greater attention has thus far been devoted towards practically oriented verification, as opposed to formally correct and rigorous documented verification.
