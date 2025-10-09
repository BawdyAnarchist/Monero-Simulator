---

## Notes on how to use the test module

---

The spreadsheet (.ods) was hand built to test the various lead-in conditions that might be experienced onchain. In order to get the script to use it, you have to save ONE of the tabs as a CSV to this directory with the filename: `selfish_equation_setup.csv`. 

Then you can just run `node selfish_equation_test.js`, and it will output to the console the result values. Sort by column C 'Description' ascending, so that you can paste the results starting at the U column 'Test'. Then sort by column A 'testId'. Be careful in this operation because there's conditional formatting so that you get red highlights for values that dont match what they should.

There are additional red highlighted test condition rows which are are unreachable states, and can be ignored.

There's one exception in `-12_full` tab, where the equation doesnt produce the desired result. This is the only deviant result, and it's handled by this line in unified_pool_agent.js:  `if (abandonThresh > 0 || selfLength === 0) {`.  In short, the `kThresh < 0` cases are disruptive to correctly abandoning when the selfish pool is on the same head as the honest tip. That is the only edge case I'm aware of.
