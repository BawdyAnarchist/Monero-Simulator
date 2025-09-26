## Monero PoW Simulator
> A modular simulation environment to test countermeasures against selfish mining strategies

This codebase implements a discrete-event framework for analyzing miner PoW dynamics in Monero, via Monte Carlo simulations. The strategy logic governing miner/pool behavior has been modularized into a pluggable system with a straightforward manifest and pool list. The purpose is to create a reproducible environment for evaluating the security and secondary effects of proposed PoW modifications.

### Features
- **FAST:** Simulates ~1 yr, 8 pools (with selfish), in ~70 sec on a single thread
- **Multi-Pool Simulation:**  Set strategy and hashrate for an arbitrary number of pools
- **Pluggable Pool Agents:**  Simple API to implement custom mining strategies
- **Tunable Selfish Behavior:** Two-parameter policy reproduces the documented variants (see: [docs/selfish-tuning.md](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/docs/selfish-tuning.md))
- **Stochastic Network Model:**  Tunable parameters with reproducible seed
- **Multi Threaded:** Run isolated rounds in parallel
- **Accurate Difficulty Adjustment:**  Monero's exact algo, bootstrapped with historical data

Refer to [config/README.md](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/config/README.md) for a quick-reference on pools and strategies configuration.   
The API for adding a custom miner strategy is at [docs/strategy-api.md](https://github.com/BawdyAnarchist/Monero-Simulator/blob/main/docs/strategy-api.md)

### Getting Started
1. Dependencies
```
cd Monero_sim/
npm install dotenv d3-random p-limit tinyqueue
```
2. Run - This will automatically create your environment files
```
npm start
# Results will be in the `data/` directory   
```
**Review *`.env`* and *`config/`* for customized runtime parameters**
