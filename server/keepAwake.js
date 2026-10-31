// Keeps Windows from going to sleep while the server runs (the screen may still turn off).
// Uses SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) in a helper PowerShell process
// that exits automatically when this Node process ends, so normal sleep comes back afterwards.
const { spawn } = require('child_process');

function start() {
  if (process.platform !== 'win32') return;
  const script = `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$t = Add-Type -MemberDefinition $sig -Name 'Power' -Namespace 'Spellbound' -PassThru
[void]$t::SetThreadExecutionState([uint32]2147483649)
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => console.log('     ⚠ Could not enable keep-awake.'));
    process.on('exit', () => child.kill());
    console.log('     💤 Keep-awake ON: this PC will not auto-sleep while the server runs.');
  } catch {
    console.log('     ⚠ Could not enable keep-awake.');
  }
}

module.exports = { start };
