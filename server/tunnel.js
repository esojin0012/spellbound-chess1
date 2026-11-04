// Optional public link using a free Cloudflare "quick tunnel" (no account, no router setup).
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findCloudflared() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  try {
    return execSync('where cloudflared', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

function start(port) {
  const exe = findCloudflared();
  if (!exe) {
    console.log('     ⚠ cloudflared not found. Install it with:  winget install Cloudflare.cloudflared');
    return;
  }
  console.log('     🌐 Opening public tunnel...');
  const child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { windowsHide: true });
  let shown = false;
  const onData = (d) => {
    const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true;
      console.log('\n  ==========================================================');
      console.log(`     🌍 PUBLIC LINK (send to your friend): ${m[0]}`);
      console.log('  ==========================================================\n');
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => console.log(`     Tunnel closed (code ${code}).`));
  process.on('exit', () => child.kill());
  process.on('SIGINT', () => process.exit());
}

module.exports = { start };
