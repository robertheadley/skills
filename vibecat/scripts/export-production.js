const fs = require('fs');
const path = require('path');

// Parse CLI Arguments
const args = process.argv.slice(2);
const sourcePath = args[0];
let outputDir = args[1] || 'dist';

if (!sourcePath) {
    console.error('\x1b[31mError: Please specify the source userscript path.\x1b[0m');
    console.log('Usage:');
    console.log('  node export-production.js <path-to-script.user.js> [output-directory]');
    process.exit(1);
}

const resolvedSourcePath = path.resolve(process.cwd(), sourcePath);
if (!fs.existsSync(resolvedSourcePath)) {
    console.error(`\x1b[31mError: File not found: ${resolvedSourcePath}\x1b[0m`);
    process.exit(1);
}

const resolvedOutputDir = path.resolve(process.cwd(), outputDir);
if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
}

let code = fs.readFileSync(resolvedSourcePath, 'utf-8');

console.log(`🔨 Exporting production version of: ${path.basename(resolvedSourcePath)}`);

// 1. Remove all DEVONLY blocks
const devOnlyRegex = /\/\/\s*DEVONLY_START[\s\S]*?\/\/\s*DEVONLY_END/g;
if (devOnlyRegex.test(code)) {
    code = code.replace(devOnlyRegex, '');
    console.log('  ✔ Stripped developer sync banners and WebSocket reload blocks (DEVONLY).');
} else {
    console.log('  ℹ No DEVONLY code blocks detected.');
}

// 2. Set ENABLE_HOT_RELOAD to false
const hotReloadVarRegex = /const\s+ENABLE_HOT_RELOAD\s*=\s*(true|false)\s*;/g;
if (hotReloadVarRegex.test(code)) {
    code = code.replace(hotReloadVarRegex, 'const ENABLE_HOT_RELOAD = false;');
    console.log('  ✔ Disabled ENABLE_HOT_RELOAD flag.');
}

// 4. Save to output directory
const outputFileName = path.basename(resolvedSourcePath);
const outputPath = path.join(resolvedOutputDir, outputFileName);
fs.writeFileSync(outputPath, code, 'utf-8');

console.log(`\x1b[32m✔ Exported clean production userscript to: ${outputPath}\x1b[0m`);
