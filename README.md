## Monero PoW Simulator
> A modular simulation environment to test countermeasures against selfish mining strategies

This codebase implements a discrete-event framework for analyzing miner PoW dynamics in Monero, via Monte Carlo simulations. The strategy logic governing behavior has been modularized into a pluggable system with a straightforward manifest and pool list. The purpose is to create a reproducible environment for evaluating the security and secondary effects of proposed PoW modifications.

### Features
- **Multi-Pool Simulation:**  Set strategy and hashrate for an arbitrary number of pools 
  - src/pools.json
- **Pluggable Strategies:**  Simple API to implement custom mining strategies
  - src/strategy_manifest.json
- **Stochastic Network Model:**  Tunable parameters with reproducible seed
  - .env
- **Multi Threaded:** Run isolated rounds in parallel
- **Accurate Difficulty Adjustment:**  Monero's exact algo, bootstrapped with historical data 

A detailed description of the model, configuration parameters, and API for strategies plugins, is in `docs/`.    
Refer to `src/README.md` for a quick-reference on pools and strategies configuration.

### Getting Started
1. Dependencies
```
cd Monero_sim/
npm install dotenv d3-random p-limit tinyqueue
```
2. Run - This will automatically create your environment files
```
npm start
```
> *Results are gzip csv, written to the `data/` directory*
3. Review `.env` and `config/` for custom configuration   
