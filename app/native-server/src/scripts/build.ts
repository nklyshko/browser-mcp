import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const distDir = path.join(__dirname, '..', '..', 'dist');
const sharedPackageDir = path.join(__dirname, '..', '..', '..', '..', 'packages', 'shared');
const sharedPackageDest = path.join(distDir, 'vendor', 'chrome-mcp-shared-2026');
// Clean the previous build
console.log('Cleaning the previous build...');
try {
  fs.rmSync(distDir, { recursive: true, force: true });
} catch (err) {
  // Ignore a missing directory
  console.log(err);
}

// Create the dist directory
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true }); // Create the logs directory
console.log('dist and dist/logs exist');

// Compile TypeScript
console.log('Compiling TypeScript...');
execSync('tsc', { stdio: 'inherit' });

// Copy configuration files
console.log('Copying configuration files...');
const configSourcePath = path.join(__dirname, '..', 'mcp', 'stdio-config.json');
const configDestPath = path.join(distDir, 'mcp', 'stdio-config.json');

try {
  // Make sure the destination directory exists
  fs.mkdirSync(path.dirname(configDestPath), { recursive: true });

  if (fs.existsSync(configSourcePath)) {
    fs.copyFileSync(configSourcePath, configDestPath);
    console.log(`Copied stdio-config.json to ${configDestPath}`);
  } else {
    console.error(`Error: configuration file not found: ${configSourcePath}`);
  }
} catch (error) {
  console.error('Failed to copy the configuration file:', error);
}

console.log('Embedding the shared runtime...');
// The published package must ship the shared runtime because the workspace
// package is private. postinstall copies this vendor copy into the package's
// own node_modules at install time.
if (!fs.existsSync(path.join(sharedPackageDir, 'dist', 'index.js'))) {
  console.error(
    `Error: the shared package dist is missing (${path.join(sharedPackageDir, 'dist')}). ` +
      'Run pnpm --filter @ethanwilkins/chrome-mcp-shared-2026 build first.',
  );
  process.exit(1);
}
fs.cpSync(path.join(sharedPackageDir, 'dist'), path.join(sharedPackageDest, 'dist'), {
  recursive: true,
});
fs.copyFileSync(
  path.join(sharedPackageDir, 'package.json'),
  path.join(sharedPackageDest, 'package.json'),
);

// Copy package.json and update its contents
console.log('Preparing package.json...');
const packageJson = require('../../package.json');

// Create the install instructions
const readmeContent = `# ${packageJson.name}

This is the Native Messaging host for the Chrome extension.

## Installation

1. Make sure Node.js is installed.
2. Install this package globally:
   \`\`\`
   npm install -g ${packageJson.name}
   \`\`\`
3. Register the Native Messaging host:
   \`\`\`
   # User-level install (recommended)
   ${packageJson.name} register

   # If the user-level install fails, try a system-level one
   ${packageJson.name} register --system
   # or run it with administrator privileges
   sudo ${packageJson.name} register
   \`\`\`

## Usage

Chrome starts this host automatically; you never need to run it by hand.
`;

fs.writeFileSync(path.join(distDir, 'README.md'), readmeContent);

console.log('Copying wrapper scripts...');
const scriptsSourceDir = path.join(__dirname, '.');
const macOsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.sh');
const windowsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.bat');

const macOsWrapperDestPath = path.join(distDir, 'run_host.sh');
const windowsWrapperDestPath = path.join(distDir, 'run_host.bat');

try {
  if (fs.existsSync(macOsWrapperSourcePath)) {
    // run_host.sh runs under bash on macOS/Linux; force LF so a CRLF working
    // copy (git core.autocrlf on Windows) can't ship a script that fails with
    // `$'\r': command not found`.
    const wrapperContent = fs.readFileSync(macOsWrapperSourcePath, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(macOsWrapperDestPath, wrapperContent, 'utf8');
    console.log(`Copied ${macOsWrapperSourcePath} to ${macOsWrapperDestPath}`);
  } else {
    console.error(`Error: macOS wrapper script not found: ${macOsWrapperSourcePath}`);
  }

  if (fs.existsSync(windowsWrapperSourcePath)) {
    fs.copyFileSync(windowsWrapperSourcePath, windowsWrapperDestPath);
    console.log(`Copied ${windowsWrapperSourcePath} to ${windowsWrapperDestPath}`);
  } else {
    console.error(`Error: Windows wrapper script not found: ${windowsWrapperSourcePath}`);
  }
} catch (error) {
  console.error('Failed to copy the wrapper scripts:', error);
}

// Mark the key JavaScript files and the macOS wrapper as executable
console.log('Adding executable permissions...');
const filesToMakeExecutable = ['index.js', 'cli.js', 'run_host.sh']; // cli.js is expected at the dist root

filesToMakeExecutable.forEach((file) => {
  const filePath = path.join(distDir, file); // the destination path
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, '755');
      console.log(`Marked ${file} executable (755)`);
    } else {
      console.warn(`Warning: ${filePath} does not exist, cannot mark it executable`);
    }
  } catch (error) {
    console.error(`Failed to mark ${file} executable:`, error);
  }
});

// Write node_path.txt immediately after build to ensure Chrome uses the correct Node.js version.
// This is critical for development mode where dist is deleted on each rebuild.
// The file points to the same Node.js that compiled the native modules (better-sqlite3 etc.)
console.log('Writing node_path.txt...');
const nodePathFile = path.join(distDir, 'node_path.txt');
fs.writeFileSync(nodePathFile, process.execPath, 'utf8');
console.log(`Wrote the Node.js path: ${process.execPath}`);

console.log('✅ Build complete');
