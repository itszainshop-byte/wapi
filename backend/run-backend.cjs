#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const RESTART_DELAY_MS = 2000;

function findExistingBackendPid() {
  const script = [
    "$conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 3000 } | Select-Object -First 1",
    "if (-not $conn) { exit 0 }",
    "$proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $conn.OwningProcess) | Select-Object -First 1",
    "if (-not $proc) { exit 0 }",
    "$cmd = [string]$proc.CommandLine",
    "if ($proc.Name -eq 'node.exe' -and (($cmd -like '*backend/server.js*') -or ($cmd -like '*backend\\server.js*'))) { Write-Output $proc.ProcessId; exit 0 }",
    "exit 0",
  ].join('; ');

  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (result.error) {
    return null;
  }

  const pidText = (result.stdout || '').trim();
  const pid = Number(pidText);
  if (Number.isInteger(pid) && pid > 0) {
    return pid;
  }

  return null;
}

const existingPid = findExistingBackendPid();
if (existingPid) {
  console.log(`WhatsApp backend already running on http://localhost:3000 (PID ${existingPid})`);
  process.exit(0);
}

const serverEntry = path.join(__dirname, 'server.js');
let stopping = false;
let child = null;

function stopChild() {
  stopping = true;
  if (child && !child.killed) {
    child.kill();
  }
}

process.once('SIGINT', stopChild);
process.once('SIGTERM', stopChild);

function startBackend() {
  child = spawn(process.execPath, [serverEntry], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error('Failed to start backend:', error);
  });

  child.on('exit', (code, signal) => {
    if (stopping) {
      process.exit(code ?? 0);
      return;
    }

    console.warn(`WhatsApp backend exited (${signal || code || 'unknown'}). Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startBackend, RESTART_DELAY_MS);
  });
}

startBackend();
