/**
 * Loads and validates the business-rule YAML files.
 *
 * Why load once at start-up and freeze: a config mistake should stop the
 * process with a clear message before it serves traffic, and nothing at
 * runtime should be able to change a rule by accident.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { type AppConfig, type ConfigName, configSchemas } from './schemas';

/** Thrown when a config file is missing, is not valid YAML, or breaks a rule. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Finds the /config directory.
 *
 * @param explicitDir - A directory given by the caller (wins over everything).
 * @param env - Environment variables; `CONFIG_DIR` is used when set.
 * @param startDir - Where to start searching upwards for a `config` folder.
 * @returns The absolute path of the config directory.
 * @throws ConfigError when no directory can be found.
 */
export function resolveConfigDir(
  explicitDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = process.cwd(),
): string {
  if (explicitDir) return resolve(explicitDir);
  if (env.CONFIG_DIR) return resolve(env.CONFIG_DIR);

  // Walk up from the working directory so apps work whether they are started
  // from the repo root or from their own folder (pnpm runs scripts per package).
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, 'config');
    if (existsSync(join(candidate, 'learning.yaml'))) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new ConfigError('Could not find the config directory. Set CONFIG_DIR.');
}

function readYaml(dir: string, name: ConfigName): unknown {
  const file = join(dir, `${name}.yaml`);
  if (!existsSync(file)) throw new ConfigError(`Missing config file: ${file}`);
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`config/${name}.yaml is not valid YAML: ${(error as Error).message}`);
  }
}

/** Recursively freezes an object so business rules cannot be mutated at runtime. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Reads, validates and freezes every business-rule file.
 *
 * @param dir - Optional config directory; see {@link resolveConfigDir}.
 * @returns The validated, read-only configuration.
 * @throws ConfigError listing every invalid value, grouped by file.
 */
export function loadConfig(dir?: string): AppConfig {
  const configDir = resolveConfigDir(dir);
  const problems: string[] = [];
  const result: Partial<Record<ConfigName, unknown>> = {};

  for (const name of Object.keys(configSchemas) as ConfigName[]) {
    const parsed = configSchemas[name].safeParse(readYaml(configDir, name));
    if (parsed.success) {
      result[name] = parsed.data;
    } else {
      problems.push(`config/${name}.yaml:\n${z.prettifyError(parsed.error)}`);
    }
  }

  // Report all files at once, so one restart shows every mistake.
  if (problems.length > 0) {
    throw new ConfigError(`Invalid business-rule configuration:\n\n${problems.join('\n\n')}`);
  }
  return deepFreeze(result as AppConfig);
}
