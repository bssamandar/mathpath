import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, deepFreeze, loadConfig, resolveConfigDir } from './load';
import { isStrictlyAscending } from './schemas';

const repoConfigDir = resolve(__dirname, '../../../config');
const tempDirs: string[] = [];

/** Copies the real config to a temp dir so a test can break one file safely. */
function copyConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mathpath-config-'));
  tempDirs.push(dir);
  cpSync(repoConfigDir, dir, { recursive: true });
  return dir;
}

function replaceIn(dir: string, file: string, from: string, to: string): void {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads the committed config without errors', () => {
    const config = loadConfig(repoConfigDir);
    expect(config.learning.masteryThreshold).toBe(0.8);
    expect(config.billing.plans.length).toBeGreaterThan(0);
    expect(config.content.defaultLocale).toBe('uz-Latn');
  });

  it('returns a frozen object so rules cannot change at runtime', () => {
    const config = loadConfig(repoConfigDir);
    expect(Object.isFrozen(config.learning.practice)).toBe(true);
    expect(() => {
      (config.learning as { masteryThreshold: number }).masteryThreshold = 0.1;
    }).toThrow(TypeError);
  });

  it('rejects an out-of-range mastery threshold and names the file', () => {
    const dir = copyConfig();
    replaceIn(dir, 'learning.yaml', 'masteryThreshold: 0.8', 'masteryThreshold: 1.5');
    expect(() => loadConfig(dir)).toThrow(/config\/learning\.yaml[\s\S]*masteryThreshold/);
  });

  it('rejects a solution shown before the hint', () => {
    const dir = copyConfig();
    replaceIn(dir, 'learning.yaml', 'solutionAfterMistakes: 2', 'solutionAfterMistakes: 1');
    expect(() => loadConfig(dir)).toThrow(/solution must come after the hint/);
  });

  it('rejects float prices, because money is integer tiyin', () => {
    const dir = copyConfig();
    replaceIn(dir, 'billing.yaml', 'priceTiyin: 9900000', 'priceTiyin: 99000.5');
    expect(() => loadConfig(dir)).toThrow(ConfigError);
  });

  it('rejects unknown keys so typos are caught', () => {
    const dir = copyConfig();
    replaceIn(dir, 'limits.yaml', 'dailyExercises: 20', 'dailyExercizes: 20');
    expect(() => loadConfig(dir)).toThrow(/limits\.yaml/);
  });

  it('rejects risk bands that do not start at zero', () => {
    const dir = copyConfig();
    replaceIn(dir, 'risk.yaml', '{ from: 0, action: allow }', '{ from: 5, action: allow }');
    expect(() => loadConfig(dir)).toThrow(/first risk band must start at 0/);
  });

  it('reports every broken file at once', () => {
    const dir = copyConfig();
    replaceIn(dir, 'learning.yaml', 'masteryThreshold: 0.8', 'masteryThreshold: -1');
    replaceIn(dir, 'content.yaml', "defaultLocale: 'uz-Latn'", "defaultLocale: 'de'");
    let message = '';
    try {
      loadConfig(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('config/learning.yaml');
    expect(message).toContain('config/content.yaml');
  });

  it('fails clearly on invalid YAML', () => {
    const dir = copyConfig();
    writeFileSync(join(dir, 'gamification.yaml'), 'xp: [unclosed');
    expect(() => loadConfig(dir)).toThrow(/gamification\.yaml is not valid YAML/);
  });

  it('fails clearly when a file is missing', () => {
    const dir = copyConfig();
    rmSync(join(dir, 'risk.yaml'));
    expect(() => loadConfig(dir)).toThrow(/Missing config file/);
  });
});

describe('resolveConfigDir', () => {
  it('prefers an explicit directory', () => {
    expect(resolveConfigDir('/tmp/x', { CONFIG_DIR: '/tmp/y' })).toBe(resolve('/tmp/x'));
  });

  it('uses CONFIG_DIR when no directory is given', () => {
    expect(resolveConfigDir(undefined, { CONFIG_DIR: '/tmp/y' })).toBe(resolve('/tmp/y'));
  });

  it('walks up from a nested folder to find /config', () => {
    const nested = join(repoConfigDir, '..', 'packages', 'config', 'src');
    expect(resolveConfigDir(undefined, {}, nested)).toBe(repoConfigDir);
  });

  it('throws when nothing is found', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mathpath-empty-'));
    tempDirs.push(empty);
    mkdirSync(join(empty, 'a'));
    expect(() => resolveConfigDir(undefined, {}, join(empty, 'a'))).toThrow(ConfigError);
  });
});

describe('helpers', () => {
  it('isStrictlyAscending', () => {
    expect(isStrictlyAscending([1, 3, 7])).toBe(true);
    expect(isStrictlyAscending([1, 1])).toBe(false);
    expect(isStrictlyAscending([])).toBe(true);
  });

  it('deepFreeze leaves primitives alone', () => {
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBeNull();
  });
});
