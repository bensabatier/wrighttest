import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { chromium, devices, firefox, webkit } from 'playwright';
import { resolveBrowserUrl } from '../utils/runtime-url';
import { resolveDeviceConfig } from '../utils/devices';
import { deriveSelectorCandidates } from '../utils/selector-variants';
import type { Step } from '../types/step';

interface RecordingSession {
  id: string;
  process: ChildProcess;
  outputFile: string;
  startUrl: string;
  projectId: string;
  userId: string;
  status: 'active' | 'stopped';
}

const sessions = new Map<string, RecordingSession>();
const TMP_DIR = '/tmp/wrighttest-codegen';
const BACKEND_DIR = fs.existsSync(path.resolve(process.cwd(), 'src', 'index.ts'))
  ? process.cwd()
  : path.resolve(process.cwd(), 'backend');
const DESKTOP_DEVICE_PRESETS = new Set(['Desktop Chrome', 'Desktop Chrome HiDPI']);

function getBrowserExecutablePath(browserType: 'chromium' | 'firefox' | 'webkit') {
  switch (browserType) {
    case 'chromium':
      return chromium.executablePath();
    case 'firefox':
      return firefox.executablePath();
    case 'webkit':
      return webkit.executablePath();
    default:
      return chromium.executablePath();
  }
}

function extractStringLiteral(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^(['"`])([\s\S]*)\1$/);
  if (!match) return null;
  return match[2]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function extractFirstStringArgument(argumentsText: string): string | null {
  const match = argumentsText.match(/(['"`])([\s\S]*?)\1/);
  if (!match) return null;
  return extractStringLiteral(match[0]);
}

function parseCodegenLine(trimmed: string): Step | null {
  // 1. Define the handler logic
  const handlers: { pattern: RegExp; handler: (m: RegExpMatchArray) => Step | null }[] = [
    {
      pattern: /^await\s+page\.goto\(([\s\S]+?)\);?$/,
      handler: (m) => {
        const url = extractFirstStringArgument(m[1]);
        return url ? { action: 'goto', value: url } : null;
      }
    },
    {
      pattern: /^await\s+page\.keyboard\.press\((.+)\);?$/,
      handler: (m) => {
        const key = extractFirstStringArgument(m[1]);
        return key ? { action: 'keyboardPress', value: key } : null;
      }
    },
    {
      pattern: /^await\s+(.+?)\.(click|fill|press|selectOption|check|uncheck)\(([\s\S]*?)\);?$/,
      handler: (m) => {
        const selector = m[1].replace(/\.$/, '');
        const method = m[2];
        const args = m[3].trim();

        if (['click', 'check', 'uncheck'].includes(method)) {
          return { action: 'click', selector, selectorCandidates: deriveSelectorCandidates(selector) };
        }
        
        const value = extractFirstStringArgument(args);
        if (!value) return null;

        if (method === 'fill') return { action: 'fill', selector, value };
        if (method === 'press') return { action: 'press', selector, value };
        if (method === 'selectOption') return { action: 'selectOption', selector, value };
        return null;
      }
    },
    {
      pattern: /^await\s+expect\(page\)\.toHaveURL\(([\s\S]+?)\);?$/,
      handler: (m) => {
        const expected = extractFirstStringArgument(m[1]);
        return expected ? { action: 'assertURL', expected } : null;
      }
    },
    {
      pattern: /^await\s+expect\(page\)\.toHaveTitle\(([\s\S]+?)\);?$/,
      handler: (m) => {
        const expected = extractFirstStringArgument(m[1]);
        return expected ? { action: 'assertTitle', expected } : null;
      }
    },
    {
      pattern: /^await\s+expect\((page\..+?)\)\.(toBeVisible|toBeHidden|toBeChecked)\(([\s\S]*?)\);?$/,
      handler: (m) => ({ action: m[2].replace('toBe', 'assert'), selector: m[1] } as Step)
    },
    {
      pattern: /^await\s+expect\((page\..+?)\)\.(toHaveText|toContainText)\(([\s\S]*?)\);?$/,
      handler: (m) => {
        const expected = extractFirstStringArgument(m[3]);
        return expected ? { 
          action: 'assertText', 
          selector: m[1], 
          expected, 
          options: { exact: m[2] === 'toHaveText' } 
        } : null;
      }
    },
    {
      pattern: /^await\s+expect\((page\..+?)\)\.toHaveValue\(([\s\S]*?)\);?$/,
      handler: (m) => {
        const expected = extractFirstStringArgument(m[2]);
        return expected ? { action: 'assertValue', selector: m[1], expected } : null;
      }
    },
    {
      pattern: /^await\s+expect\((page\..+?)\)\.toHaveCount\(([\s\S]*?)\);?$/,
      handler: (m) => {
        const expected = extractFirstStringArgument(m[2]) ?? m[2].trim();
        return expected ? { action: 'assertCount', selector: m[1], expected } : null;
      }
    }
  ];

  // 2. Execution Loop
  for (const { pattern, handler } of handlers) {
    const match = trimmed.match(pattern);
    if (match) return handler(match);
  }

  return null;
}

export function parseCodegenOutput(code: string): Step[] {
  const steps: Step[] = [];

  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('await ')) continue;

    const step = parseCodegenLine(trimmed);
    if (step) {
      steps.push(step);
    }
  }

  return steps;
}

async function waitForProcessExit(process: ChildProcess, timeoutMs = 5000): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true;

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      process.kill('SIGKILL');
      resolve(true);
    }, timeoutMs);

    process.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function logProcessOutput(id: string, streamName: 'stdout' | 'stderr', chunk: Buffer | string) {
  const text = chunk.toString();
  if (!text.trim()) return;
  console.log(`[Codegen ${id} ${streamName}] ${text.trimEnd()}`);
}

async function terminateProcessGroup(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGKILL'];

  for (const signal of signals) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // Ignore and move on to the next signal.
      }
    }

    if (await waitForProcessExit(proc, 1500)) return;
  }
}

async function stopActiveSessions() {
  const activeSessions = Array.from(sessions.values());
  await Promise.all(activeSessions.map((session) => terminateProcessGroup(session.process)));
  sessions.clear();
}

async function assertRecordingBrowserAvailable(device?: string) {
  if (!device || !(device in devices)) return;

  const browserType = devices[device as keyof typeof devices].defaultBrowserType;
  if (!browserType || browserType === 'chromium') return;

  const browserPath = getBrowserExecutablePath(browserType as 'chromium' | 'firefox' | 'webkit');
  try {
    await fsPromises.access(browserPath);
  } catch {
    throw new Error(
      `Recording with "${device}" requires Playwright ${browserType}, but it is not installed on this machine. ` +
        `Run "PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install ${browserType}" or choose a Chromium-based desktop preset.`
    );
  }
}

export async function startRecording(startUrl: string, device?: string, projectId?: string, userId?: string): Promise<string> {
  await fsPromises.mkdir(TMP_DIR, { recursive: true });

  const id = uuidv4();
  const outputFile = path.join(TMP_DIR, `${id}.ts`);
  const resolvedUrl = resolveBrowserUrl(startUrl);
  const env = { ...process.env };
  await stopActiveSessions();
  await assertRecordingBrowserAvailable(device);

  const isDesktopPreset = device ? DESKTOP_DEVICE_PRESETS.has(device) : false;
  const deviceArgs = device && !isDesktopPreset ? ['--device', device] : [];
  const deviceOptions = resolveDeviceConfig(device);
  const viewport = deviceOptions.viewport;
  const viewportArgs = viewport ? ['--viewport-size', `${viewport.width},${viewport.height}`] : [];

  const proc = spawn(
    'npx',
    [
      'playwright',
      'codegen',
      '--browser',
      'chromium',
      ...deviceArgs,
      ...viewportArgs,
      '--output',
      outputFile,
      resolvedUrl
    ],
    {
      cwd: BACKEND_DIR,
      env,
      stdio: 'pipe',
      detached: true
    }
  );

  console.log(
    `[Codegen ${id}] start url=${resolvedUrl} device=${device ?? 'desktop'} browser=chromium args=${JSON.stringify([
      'playwright',
      'codegen',
      '--browser',
      'chromium',
      ...deviceArgs,
      ...viewportArgs,
      '--output',
      outputFile,
      resolvedUrl
    ])}`
  );

  proc.stdout?.on('data', (chunk) => logProcessOutput(id, 'stdout', chunk));
  proc.stderr?.on('data', (chunk) => logProcessOutput(id, 'stderr', chunk));

  proc.once('error', (error) => {
    console.error(`[Codegen ${id}] Failed to start:`, error);
  });

  sessions.set(id, {
    id,
    process: proc,
    outputFile,
    startUrl: resolvedUrl,
    projectId: projectId ?? '',
    userId: userId ?? '',
    status: 'active'
  });

  return id;
}

export async function stopRecording(id: string): Promise<Step[]> {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`Session ${id} not found`);
  }

  session.status = 'stopped';
  await terminateProcessGroup(session.process);

  let steps: Step[] = [];
  try {
    const code = await fsPromises.readFile(session.outputFile, 'utf-8');
    console.log('[Codegen ${id}] Recording stopped. Parsing output file...', code);
    steps = parseCodegenOutput(code);
    console.log(`[Codegen ${id}] Recording stopped. Parsed ${steps.length} steps.`);
  } catch (error) {
    console.warn(`[Codegen ${id}] Output file not found or unreadable:`, error);
  } finally {
    await fsPromises.rm(session.outputFile, { force: true });
    sessions.delete(id);
  }

  return steps;
}

export function getRecordingStatus(id: string) {
  const session = sessions.get(id);
  if (!session) return null;

  return {
    id: session.id,
    status: session.status,
    startUrl: session.startUrl,
    outputFile: session.outputFile,
    projectId: session.projectId,
    userId: session.userId
  };
}
