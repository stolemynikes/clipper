import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { paths } from './env.ts';

export interface Hardware {
  gpu: { name: string; vramMiB: number; driver: string } | null;
  ramGB: number;
  cpu: { name: string; cores: number; threads: number };
  nvenc: string[];
  workDrive: { letter: string; freeGB: number; mediaType: string };
}

export interface HardwareConfig extends Hardware {
  checkedAt: string;
  whisperModelVod: string;
  whisperModelLive: string;
  encoder: string;
  maxParallelRenders: number;
  workDir: string;
  warnings: string[];
}

export const hardwareFile = join(paths.configDir, 'hardware.json');

/** Runs a command and returns trimmed stdout, or null if it is missing or fails. */
export function run(cmd: string, args: string[] = []): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60_000 }).trim();
  } catch (err) {
    // Some CLIs (TwitchDownloaderCLI --version) print to stderr and exit non-zero.
    const e = err as { stdout?: string; stderr?: string };
    return e.stdout?.trim() || e.stderr?.trim() || null;
  }
}

const powershell = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

export function detectHardware(workDir = paths.dataDir): Hardware {
  const letter = parse(workDir).root.slice(0, 1).toUpperCase();
  const gpuCsv = run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  const [gpuName, vram, driver] = gpuCsv?.split('\n')[0].split(',').map((s) => s.trim()) ?? [];

  const sys = JSON.parse(
    powershell(`
      $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
      $drive = Get-PSDrive -Name ${letter}
      $media = try { (Get-Partition -DriveLetter ${letter} | Get-Disk | ForEach-Object { Get-PhysicalDisk -DeviceNumber $_.Number }).MediaType } catch { 'Unknown' }
      [pscustomobject]@{
        ramBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
        cpuName = $cpu.Name.Trim(); cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors
        freeBytes = $drive.Free; media = "$media"
      } | ConvertTo-Json -Compress`) ?? '{}',
  );

  const encoders = run('ffmpeg', ['-hide_banner', '-encoders']) ?? '';
  return {
    gpu: gpuName ? { name: gpuName, vramMiB: Number(vram), driver } : null,
    ramGB: Math.round((sys.ramBytes / 2 ** 30) * 10) / 10,
    cpu: { name: sys.cpuName, cores: sys.cores, threads: sys.threads },
    nvenc: [...encoders.matchAll(/\s(\w+_nvenc)\s/g)].map((m) => m[1]),
    workDrive: { letter, freeGB: Math.round(sys.freeBytes / 2 ** 30), mediaType: sys.media || 'Unknown' },
  };
}

export function deriveConfig(hw: Hardware, workDir = paths.dataDir): HardwareConfig {
  const vramGB = (hw.gpu?.vramMiB ?? 0) / 1024;
  const nvenc = hw.nvenc.includes('h264_nvenc');
  const warnings: string[] = [];
  if (!workDir.toUpperCase().startsWith('E:')) warnings.push(`workDir ${workDir} is not on E:`);
  if (hw.workDrive.freeGB < 100) warnings.push(`only ${hw.workDrive.freeGB}GB free on ${hw.workDrive.letter}: (want 100GB+)`);
  if (hw.workDrive.mediaType === 'HDD') warnings.push(`${hw.workDrive.letter}: is an HDD: downloads and renders will be I/O bound`);
  if (!hw.gpu) warnings.push('no NVIDIA GPU found: Whisper will run on CPU (slow)');
  if (!nvenc) warnings.push('h264_nvenc not available: falling back to libx264');
  return {
    checkedAt: new Date().toISOString().slice(0, 10),
    ...hw,
    whisperModelVod: 'medium', // large-v3 (faster-whisper, VAD on) drifted words by seconds and dropped punctuation on real clips; medium is right on both
    whisperModelLive: 'large-v3-turbo', // distil-large-v3 is English-only
    encoder: nvenc ? 'h264_nvenc' : 'libx264',
    // ~4GB VRAM per render+transcribe slot, and one slot per 4 cores for audio/mux work.
    maxParallelRenders: Math.max(1, Math.min(nvenc ? Math.floor(vramGB / 4) : Infinity, Math.floor(hw.cpu.cores / 4))),
    workDir,
    warnings,
  };
}

export function readHardwareConfig(): HardwareConfig | null {
  return existsSync(hardwareFile) ? JSON.parse(readFileSync(hardwareFile, 'utf8')) : null;
}

export function writeHardwareConfig(cfg: HardwareConfig) {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(hardwareFile, JSON.stringify(cfg, null, 2) + '\n');
}

/** Compares live hardware with config/hardware.json; run at every start. */
export function checkHardware(): { live: HardwareConfig; saved: HardwareConfig | null; drift: string[] } {
  const live = deriveConfig(detectHardware());
  const saved = readHardwareConfig();
  const drift: string[] = [];
  if (!saved) drift.push('config/hardware.json missing: run `npm run hardware`');
  else {
    if (saved.gpu?.name !== live.gpu?.name) drift.push(`GPU changed: ${saved.gpu?.name} -> ${live.gpu?.name}`);
    if (saved.encoder !== live.encoder) drift.push(`encoder changed: ${saved.encoder} -> ${live.encoder}`);
    if (saved.whisperModelVod !== live.whisperModelVod) drift.push(`whisperModelVod should be ${live.whisperModelVod}`);
    if (saved.whisperModelLive !== live.whisperModelLive) drift.push(`whisperModelLive should be ${live.whisperModelLive}`);
    if (saved.maxParallelRenders !== live.maxParallelRenders) drift.push(`maxParallelRenders should be ${live.maxParallelRenders}`);
  }
  return { live, saved, drift };
}

if (import.meta.main && process.argv.includes('--write')) {
  const cfg = deriveConfig(detectHardware());
  writeHardwareConfig(cfg);
  console.log(JSON.stringify(cfg, null, 2));
}
