'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let checked = 0;
function check(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) check(file);
        else if (file.endsWith('.js') || file.endsWith('.cjs')) {
            execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); checked++;
        }
    }
}
check(path.join(__dirname, '..', 'src'));
console.log('JavaScript syntax checked: ' + checked + ' files');
