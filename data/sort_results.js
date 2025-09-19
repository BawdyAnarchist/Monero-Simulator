/*
   `results_scores.csv.gz` is sorted by poolId. Use this script to sort it by simClock instead
*/

import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';

try {
    const lines = [];
    const rl = readline.createInterface({
        input: fs.createReadStream('001_results_scores.csv.gz').pipe(zlib.createGunzip())
    });

    for await (const line of rl) {
        lines.push(line);
    }

    const header = lines.shift();
    lines.sort((a, b) => {
        return parseFloat(a.split(',')[3]) - parseFloat(b.split(',')[3]);
    });

    fs.writeFileSync('001_sorted.csv', [header, ...lines].join('\n'));
} catch (err) {
    console.error('An error occurred:', err);
}
